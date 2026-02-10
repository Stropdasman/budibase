import {
  InlinePdfImagesRequest,
  InlinePdfImagesResponse,
  UserCtx,
} from "@budibase/types"
import env from "../../environment"
import { inlineExternalImages } from "../../utilities/pdf/inlineExternalImages"

const parseAllowDomains = (value: string) =>
  value
    .split(",")
    .map(domain => domain.trim())
    .filter(Boolean)

export async function inlineImages(
  ctx: UserCtx<InlinePdfImagesRequest, InlinePdfImagesResponse>
) {
  const html = ctx.request.body?.html
  if (!html || typeof html !== "string") {
    ctx.throw("HTML is required", 400)
  }

  if (!env.PDF_INLINE_EXTERNAL_IMAGES) {
    ctx.body = { html }
    return
  }

  try {
    const processed = await inlineExternalImages(html, {
      timeoutMs: env.PDF_IMAGE_TIMEOUT_MS,
      maxBytes: env.PDF_IMAGE_MAX_BYTES,
      allowDomains: parseAllowDomains(env.PDF_IMAGE_ALLOW_DOMAINS),
      blockPrivateIps: env.PDF_IMAGE_BLOCK_PRIVATE_IPS,
    })

    ctx.body = { html: processed }
  } catch (error) {
    console.log("pdf: inline images failed", {
      reason: error instanceof Error ? error.message : "unknown",
    })
    ctx.body = { html }
  }
}
