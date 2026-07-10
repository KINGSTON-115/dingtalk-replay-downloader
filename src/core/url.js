const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SENSITIVE_QUERY_NAME = /(?:token|auth|key|signature|sign|credential|session|cookie|ticket|secret|expires?|roomid|liveuuid|user(?:id)?|uuid|wstime|txtime|policy)/i;

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

export function normalizeUserInput(value) {
  let text = String(value || "").trim().replace(/\u200b/g, "");
  if (!text) return "";
  if (/^(?:blob|data):/i.test(text)) return text;

  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (match) text = match[0];
  else if (/^[\w.-]+\.[\w.-]+/.test(text)) text = `https://${text.replace(/^\/+/, "")}`;

  return text.replace(/[)\]}>，。；、]+$/g, "").trim();
}

export function resolveHttpUrl(baseUrl, value) {
  if (!value) return "";
  const url = new URL(String(value), baseUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`不支持的资源协议：${url.protocol}`);
  return url.href;
}

export function sanitizeFileName(value, fallback = "web-video") {
  let cleaned = String(value || fallback)
    .normalize("NFKC")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 160);

  if (!cleaned) cleaned = fallback;
  if (WINDOWS_RESERVED_NAMES.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

export function titleFromUrl(value, fallback = "web-video") {
  try {
    const url = new URL(value);
    const raw = url.pathname.split("/").filter(Boolean).pop() || fallback;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // 保留无法解码的原始路径片段。
    }
    return sanitizeFileName(decoded.replace(/\.[a-z0-9]{2,6}$/i, "") || fallback, fallback);
  } catch {
    return sanitizeFileName(fallback);
  }
}

export function fileNameFromContentDisposition(value) {
  const text = String(value || "");
  const encoded = text.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encoded) {
    try {
      return sanitizeFileName(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, "")));
    } catch {
      // 继续尝试普通 filename。
    }
  }
  const plain = text.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return plain ? sanitizeFileName((plain[1] || plain[2]).trim()) : "";
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const [name, queryValue] of url.searchParams.entries()) {
      if (SENSITIVE_QUERY_NAME.test(name) || queryValue.length > 32) {
        url.searchParams.set(name, "***");
      }
    }
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.href;
  } catch {
    return String(value || "");
  }
}

export function originPattern(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("只能授权 HTTP 或 HTTPS 来源。");
  return `${url.origin}/*`;
}

export function stableId(...parts) {
  const text = parts.map((part) => String(part ?? "")).join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function extensionFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    return pathname.match(/\.([a-z0-9]{2,6})$/i)?.[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}
