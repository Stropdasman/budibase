import dns from "dns"
import nock from "nock"
import {
  inlineExternalImages,
  TRANSPARENT_PNG_DATA_URI,
} from "../inlineExternalImages"

describe("inlineExternalImages", () => {
  const lookupSpy = jest.spyOn(dns.promises, "lookup")

  beforeEach(() => {
    lookupSpy.mockResolvedValue([
      {
        address: "93.184.216.34",
        family: 4,
      },
    ])
  })

  afterEach(() => {
    nock.cleanAll()
    jest.clearAllMocks()
  })

  it("inlines external images as data URIs", async () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47])

    nock("https://example.com")
      .get("/image.png")
      .reply(200, buffer, { "Content-Type": "image/png" })

    const html = '<img src="https://example.com/image.png" />'
    const result = await inlineExternalImages(html)

    expect(result).toContain("data:image/png;base64")
  })

  it("leaves data URIs untouched", async () => {
    const html =
      '<img src="data:image/png;base64,abcd" /><img src="/local.png" />'

    const result = await inlineExternalImages(html)

    expect(result).toContain("data:image/png;base64,abcd")
    expect(result).toContain("/local.png")
  })

  it("blocks localhost and private IPs", async () => {
    const html = '<img src="http://localhost/image.png" />'

    const result = await inlineExternalImages(html)

    expect(result).toContain(TRANSPARENT_PNG_DATA_URI)
  })

  it("enforces max byte size", async () => {
    const buffer = Buffer.alloc(10, 1)

    nock("https://example.com")
      .get("/large.png")
      .reply(200, buffer, { "Content-Type": "image/png" })

    const html = '<img src="https://example.com/large.png" />'
    const result = await inlineExternalImages(html, { maxBytes: 2 })

    expect(result).toContain(TRANSPARENT_PNG_DATA_URI)
  })
})
