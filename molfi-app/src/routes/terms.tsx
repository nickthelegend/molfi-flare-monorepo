import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/components/SiteShell";
import { PageHeader } from "@/components/PageHeader";
import { APP_NAME, pageTitle } from "@/lib/brand";
import { pageSimple } from "@/lib/leverx/tw";
import { ScrollText } from "lucide-react";
import { routePendingOptions } from "@/lib/router/route-options";

export const Route = createFileRoute("/terms")({
  ...routePendingOptions,
  loader: () => null,
  head: () => ({
    meta: [
      { title: pageTitle("Terms of Service") },
      { name: "description", content: `Terms for using ${APP_NAME}.` },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <SiteShell>
      <div className={pageSimple}>
        <PageHeader
          icon={<ScrollText className="h-5 w-5 text-accent" />}
          title="Terms of Service"
          subtitle="Last updated June 13, 2026"
        />
        <article className="space-y-6 text-sm leading-relaxed text-muted-foreground">
          <Clause n="1" title="Using the service">
            By using {APP_NAME}, you agree to these terms. The app is provided as-is on Flare
            Coston2 testnet. You are responsible for understanding the risks of prediction-market
            trading.
          </Clause>

          <Clause n="2" title="Eligibility">
            You confirm you are of legal age in your jurisdiction and that interacting with
            on-chain prediction markets is not prohibited by applicable law. Residents of restricted
            jurisdictions must not use this interface.
          </Clause>

          <Clause n="3" title="No financial advice">
            Nothing on {APP_NAME} constitutes financial, legal, or tax advice. Oracle prices and
            premiums are computed mechanically from on-chain state and may be inaccurate due to
            oracle latency.
          </Clause>

          <Clause n="4" title="Protocol risks">
            Smart contract risk, FTSOv2 oracle deviation, and FAssets collateral risk all apply.
            The {APP_NAME} interface does not custody funds — stakes are escrowed by the
            PredictEscrow contract on Flare Coston2 and settled from the FTSOv2 feed. FXRP is the
            FAssets representation of XRP, not a USD-pegged stablecoin, so its value moves with
            XRP.
          </Clause>

          <Clause n="5" title="Limitation of liability">
            To the maximum extent permitted by law, the contributors to {APP_NAME} shall not be
            liable for any direct, indirect, incidental, consequential, or punitive damages arising
            from your use of the protocol.
          </Clause>

          <Clause n="6" title="Changes to terms">
            These terms may change as the protocol evolves. Continued use after a change constitutes
            acceptance of the revised terms.
          </Clause>
      </article>
      </div>
    </SiteShell>
  );
}

function Clause({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="flex items-baseline gap-2 text-base font-semibold text-foreground">
        <span className="text-sm text-accent">{n}.</span>
        {title}
      </h2>
      <p className="mt-2">{children}</p>
    </section>
  );
}
