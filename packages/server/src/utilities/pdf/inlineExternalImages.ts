import cheerio from "cheerio"
import dns from "dns"
import net from "net"
import fetch, { type Response } from "node-fetch"

export const TRANSPARENT_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="

export interface InlineExternalImagesOptions {
  timeoutMs?: number
  maxBytes?: number
  allowDomains?: string[]
  blockPrivateIps?: boolean
}

const DEFAULT_OPTIONS: Required<InlineExternalImagesOptions> = {
  timeoutMs: 8000,
  maxBytes: 5 * 1024 * 1024,
  allowDomains: [],
  blockPrivateIps: true,
}

const PRIVATE_IPV4_RANGES = [
  { from: "10.0.0.0", to: "10.255.255.255" },
  { from: "172.16.0.0", to: "172.31.255.255" },
  { from: "192.168.0.0", to: "192.168.255.255" },
  { from: "127.0.0.0", to: "127.255.255.255" },
]

const PRIVATE_IPV6_PREFIXES = ["::1", "fc", "fd", "fe80"]

export async function inlineExternalImages(
  html: string,
  options: InlineExternalImagesOptions = {}
) {
  const resolvedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  }

  if (!html || !html.includes("<img")) {
    return html
  }

  const $ = cheerio.load(html, { decodeEntities: false })
  const images = $("img").toArray()
  const cache = new Map<string, Promise<string>>()

  await Promise.all(
    images.map(async image => {
      const src = $(image).attr("src")
      if (!src || src.startsWith("data:")) {
        return
      }

      let url: URL
      try {
        url = new URL(src)
      } catch (error) {
        return
      }

      if (!isHttpUrl(url)) {
        return
      }

      const dataUri = await getDataUriForUrl(
        url,
        resolvedOptions,
        cache
      )
      $(image).attr("src", dataUri)
    })
  )

  return $.root().html() || html
}

async function getDataUriForUrl(
  url: URL,
  options: Required<InlineExternalImagesOptions>,
  cache: Map<string, Promise<string>>
) {
  const cacheKey = url.toString()
  if (!cache.has(cacheKey)) {
    cache.set(
      cacheKey,
      fetchImageAsDataUri(url, options).catch(error => {
        console.log("pdf: inline image failed", {
          url: cacheKey,
          reason: error instanceof Error ? error.message : "unknown",
        })
        return TRANSPARENT_PNG_DATA_URI
      })
    )
  }

  return cache.get(cacheKey)!
}

async function fetchImageAsDataUri(
  url: URL,
  options: Required<InlineExternalImagesOptions>
): Promise<string> {
  if (!isUrlAllowed(url, options)) {
    throw new Error("URL blocked by allowlist or SSRF protection")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
    })

    if (!response.ok) {
      throw new Error(`Image request failed with ${response.status}`)
    }

    const buffer = await readStreamWithLimit(response, options.maxBytes)
    const contentType = resolveContentType(
      response.headers.get("content-type"),
      buffer
    )
    const base64 = buffer.toString("base64")

    console.log("pdf: inline image ok", {
      url: url.toString(),
      bytes: buffer.length,
    })

    return `data:${contentType};base64,${base64}`
  } finally {
    clearTimeout(timeout)
  }
}

function isHttpUrl(url: URL) {
  return url.protocol === "http:" || url.protocol === "https:"
}

function isUrlAllowed(
  url: URL,
  options: Required<InlineExternalImagesOptions>
) {
  const hostname = url.hostname.toLowerCase()

  if (!isDomainAllowed(hostname, options.allowDomains)) {
    return false
  }

  if (!options.blockPrivateIps) {
    return true
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return false
  }

  const ipType = net.isIP(hostname)
  if (ipType) {
    return !isPrivateIpLiteral(hostname)
  }

  return resolveAndCheckHostname(hostname)
}

function isDomainAllowed(hostname: string, allowDomains: string[]) {
  if (!allowDomains.length) {
    return true
  }

  return allowDomains.some(domain => {
    const normalizedDomain = domain.toLowerCase()
    return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
  })
}

function isPrivateIpLiteral(hostname: string) {
  if (net.isIP(hostname) === 6) {
    return PRIVATE_IPV6_PREFIXES.some(prefix =>
      hostname.toLowerCase().startsWith(prefix)
    )
  }

  const numeric = ipv4ToNumber(hostname)
  if (numeric === null) {
    return false
  }

  return PRIVATE_IPV4_RANGES.some(range => {
    const from = ipv4ToNumber(range.from)
    const to = ipv4ToNumber(range.to)
    if (from === null || to === null) {
      return false
    }
    return numeric >= from && numeric <= to
  })
}

function ipv4ToNumber(ip: string) {
  const parts = ip.split(".").map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part))) {
    return null
  }
  return parts.reduce((acc, part) => (acc << 8) + part)
}

async function resolveAndCheckHostname(hostname: string) {
  try {
    const results = await dns.promises.lookup(hostname, { all: true })
    return !results.some(result => isPrivateIpLiteral(result.address))
  } catch (error) {
    return true
  }
}

async function readStreamWithLimit(response: Response, maxBytes: number) {
  const chunks: Buffer[] = []
  let total = 0

  if (!response.body) {
    return Buffer.alloc(0)
  }

  for await (const chunk of response.body as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > maxBytes) {
      throw new Error("Image exceeds maximum allowed size")
    }
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

function resolveContentType(contentType: string | null, buffer: Buffer) {
  if (contentType && contentType.startsWith("image/")) {
    return contentType.split(";")[0]
  }

  const detected = detectImageType(buffer)
  return detected ? `image/${detected}` : "image/png"
}

function detectImageType(buffer: Buffer) {
  if (buffer.length < 12) {
    return null
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png"
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg"
  }

  if (buffer.slice(0, 3).toString("ascii") === "GIF") {
    return "gif"
  }

  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp"
  }

  return null
}
