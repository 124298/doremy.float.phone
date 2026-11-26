// 服务端 LLM 转发路由。
//
// 为什么需要它：浏览器直连第三方大模型 API 时，POST + application/json 会先触发
// CORS 预检（OPTIONS）。不少服务商（如智谱 open.bigmodel.cn）对推理端点的预检不返回
// 跨域许可头，于是浏览器在预检阶段就拦下请求，前端只能看到 "Failed to fetch"，
// 请求根本没到达对方服务器。此时唯一可靠的解法是由本站服务端代为转发：
// 同源请求没有跨域限制，服务端之间也没有 CORS。
//
// 注意：API Key 会经过本实例的服务端。请只在自己的部署上使用，不要把地址与
// 密钥分享给不信任的第三方代理。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 逐跳头（RFC 7230 §6.1），转发时必须剔除，否则会破坏连接语义。 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "accept-encoding",
]);

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * 目标地址必须是公网 https。
 *
 * 这条转发路由会被浏览器调用，如果允许任意地址，就等于把这个部署变成可被
 * 借道访问内网 / 元数据服务的跳板（SSRF）。因此这里显式拒绝明文 http、
 * 本机名与一切私有网段。
 */
function assertSafeTargetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("目标地址不是合法 URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("只允许转发到 https 地址");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host.endsWith(".lan")
    || host.endsWith(".home.arpa")
    || host.startsWith("[")
    || host.includes(":")
    || isPrivateIpv4(host)
  ) {
    throw new Error("不允许转发到本机或内网地址");
  }
  return url;
}

/** 只保留字符串键值，并剔除逐跳头与浏览器专属头。 */
function sanitizeForwardHeaders(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input || typeof input !== "object") return result;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // 这些头是浏览器根据实际连接自动生成的，转发过去会污染目标服务器的判断。
    if (lower === "host" || lower === "origin" || lower === "referer" || lower === "cookie") continue;
    if (lower.startsWith("sec-")) continue;
    result[key] = value;
  }
  return result;
}

export async function POST(request: Request): Promise<Response> {
  let payload: { url?: unknown; headers?: unknown; body?: unknown };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  let target: URL;
  try {
    if (typeof payload.url !== "string" || !payload.url.trim()) {
      return Response.json({ error: "缺少目标地址" }, { status: 400 });
    }
    target = assertSafeTargetUrl(payload.url.trim());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "目标地址不可用" },
      { status: 400 },
    );
  }

  const bodyText = typeof payload.body === "string"
    ? payload.body
    : payload.body === undefined
      ? undefined
      : JSON.stringify(payload.body);
  if (bodyText === undefined) {
    return Response.json({ error: "缺少请求体" }, { status: 400 });
  }

  const headers = sanitizeForwardHeaders(payload.headers);
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers,
      body: bodyText,
      // 不跟随重定向：避免被引导到内网地址绕过上面的校验。
      redirect: "manual",
    });
  } catch (error) {
    return Response.json(
      {
        error: `上游请求失败：${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  }

  // 原样透传状态码与响应体：调用方（流式解析、错误提示）依赖真实状态判断成败，
  // 这里改写状态会让 400/401/429 全部退化成无法解释的成功。
  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("Content-Type", contentType);
  responseHeaders.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
