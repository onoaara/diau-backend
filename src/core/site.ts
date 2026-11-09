import { z } from "zod";

const optionalUrl = z.union([z.url(), z.literal("")]).default("");

const DEFAULT_PAYMENT_METHODS = [
  {
    id: "cod",
    label: "Pay on delivery",
    description: "Pay the courier by cash or card when your order arrives.",
    instructions: "Have the exact amount ready, or pay by card on the courier's terminal.",
    enabled: true,
  },
  {
    id: "bank_transfer",
    label: "Bank transfer",
    description: "Transfer the total to our bank account. We ship once it arrives.",
    instructions: "Bank: Diau Demo Bank · Account name: Diau Marketplace · Account number: 00012345678 · Reference: your order number. Orders are held for 5 days.",
    enabled: true,
  },
];

export const siteConfigSchema = z
  .object({
    storeName: z.string().min(1).max(60).default("Diau"),
    tagline: z.string().max(120).default("Buy and sell almost anything."),
    locale: z.string().default("en-US"),
    currency: z.string().length(3).default("USD"),
    contact: z
      .object({
        email: z.union([z.email(), z.literal("")]).default("support@diau.test"),
        phone: z.string().max(40).default(""),
        address: z.string().max(240).default(""),
      })
      .default({ email: "support@diau.test", phone: "", address: "" }),
    announcement: z
      .object({
        enabled: z.boolean().default(false),
        /** Changing the id re-shows the bar to shoppers who dismissed the previous one. */
        id: z.string().default("default"),
        text: z.string().max(160).default(""),
        linkLabel: z.string().max(40).default(""),
        linkUrl: z.string().max(500).default(""),
      })
      .default({ enabled: false, id: "default", text: "", linkLabel: "", linkUrl: "" }),
    /** Global commerce copy shown on product pages; products can override. */
    policies: z
      .object({
        shipping: z.string().max(1000).default(""),
        returns: z.string().max(1000).default(""),
        payments: z.string().max(1000).default(""),
      })
      .default({ shipping: "", returns: "", payments: "" }),
    social: z
      .object({
        facebook: optionalUrl,
        instagram: optionalUrl,
        x: optionalUrl,
        tiktok: optionalUrl,
        youtube: optionalUrl,
      })
      .default({ facebook: "", instagram: "", x: "", tiktok: "", youtube: "" }),
    seo: z
      .object({
        titleTemplate: z.string().default("%s | Diau"),
        defaultTitle: z.string().default("Diau: buy and sell almost anything"),
        defaultDescription: z.string().max(300).default(""),
        ogImageUrl: z.string().default(""),
        /** Off: robots.txt disallows everything and pages send noindex (e.g. while setting up). */
        allowIndexing: z.boolean().default(true),
      })
      .default({ titleTemplate: "%s | Diau", defaultTitle: "Diau: buy and sell almost anything", defaultDescription: "", ogImageUrl: "", allowIndexing: true }),
    analytics: z
      .object({
        googleAnalyticsId: z.string().max(40).default(""),
        plausibleDomain: z.string().max(120).default(""),
      })
      .default({ googleAnalyticsId: "", plausibleDomain: "" }),
    features: z
      .object({
        voiceSearch: z.boolean().default(true),
        imageSearch: z.boolean().default(true),
        mobileBottomNav: z.boolean().default(false),
        guestCheckout: z.boolean().default(true),
        reviewsRequireApproval: z.boolean().default(true),
      })
      .default({ voiceSearch: true, imageSearch: true, mobileBottomNav: false, guestCheckout: true, reviewsRequireApproval: true }),
    /**
     * Checkout. No payment gateway yet: each enabled method creates a manual
     * payment that an admin marks paid. Ids are stable (stored on payments).
     */
    checkout: z
      .object({
        paymentMethods: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z0-9_]{2,30}$/),
              label: z.string().min(1).max(40),
              description: z.string().max(200).default(""),
              /** Shown after ordering (e.g. bank details). */
              instructions: z.string().max(1000).default(""),
              enabled: z.boolean().default(true),
            }),
          )
          .max(8)
          .default(DEFAULT_PAYMENT_METHODS),
        termsUrl: z.string().max(200).default("/terms"),
        privacyUrl: z.string().max(200).default("/privacy"),
      })
      .default({ paymentMethods: DEFAULT_PAYMENT_METHODS, termsUrl: "/terms", privacyUrl: "/privacy" }),
    /** Header utility links that aren't menu-managed. */
    sellLink: z
      .object({ enabled: z.boolean().default(true), label: z.string().default("Sell"), url: z.string().default("/sell") })
      .default({ enabled: true, label: "Sell", url: "/sell" }),
  })
  .strict();

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export const DEFAULT_SITE: SiteConfig = siteConfigSchema.parse({});
