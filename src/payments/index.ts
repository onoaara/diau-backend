import type { SiteConfig } from "../core";

/**
 * Payment providers. No gateway is integrated yet (per the project brief):
 * the manual provider offers the offline methods enabled in Site Settings and
 * records a PENDING payment that an admin marks paid. A card/wallet gateway
 * implements this same interface (e.g. returning a redirect or client secret
 * from `initiate`) without changing checkout.
 */
export type PaymentMethodOption = { id: string; label: string; description: string; provider: string };

export type InitiatedPayment = {
  provider: string;
  method: string;
  status: "PENDING" | "AUTHORIZED" | "PAID";
  /** Shown on the confirmation page (e.g. bank details). */
  instructions: string;
};

export interface PaymentProvider {
  id: string;
  methods(site: SiteConfig): PaymentMethodOption[];
  initiate(input: { site: SiteConfig; methodId: string; amountCents: number; currency: string; orderNumber: string }): Promise<InitiatedPayment>;
}

export const manualProvider: PaymentProvider = {
  id: "manual",
  methods: (site) =>
    site.checkout.paymentMethods.filter((m) => m.enabled).map((m) => ({ id: m.id, label: m.label, description: m.description, provider: "manual" })),
  async initiate({ site, methodId }) {
    const method = site.checkout.paymentMethods.find((m) => m.id === methodId && m.enabled);
    if (!method) throw new Error(`Unknown payment method ${methodId}`);
    return { provider: "manual", method: method.id, status: "PENDING", instructions: method.instructions };
  },
};

export const paymentProviders: PaymentProvider[] = [manualProvider];

export function paymentMethods(site: SiteConfig): PaymentMethodOption[] {
  return paymentProviders.flatMap((p) => p.methods(site));
}

export function providerFor(methodId: string, site: SiteConfig): PaymentProvider | null {
  return paymentProviders.find((p) => p.methods(site).some((m) => m.id === methodId)) ?? null;
}
