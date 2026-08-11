import { createFileRoute } from "@tanstack/react-router";
import { PitchDeck } from "@/components/pitch/PitchDeck";
import { APP_NAME, pageTitle } from "@/lib/brand";
import { routePendingOptions } from "@/lib/router/route-options";

export const Route = createFileRoute("/pitch")({
  ...routePendingOptions,
  loader: () => null,
  head: () => ({
    meta: [
      { title: pageTitle("Pitch") },
      // Inherited from the Sui fork this was ported from: the description said
      // "leveraged prediction markets on DeepBook Predict" and the og card
      // offered leverage. Molfi has neither — it is pari-mutuel, on Flare, and
      // DeepBook is gone. Link previews were advertising a different product.
      {
        name: "description",
        content: `${APP_NAME} — animated pitch deck for XRP-settled prediction markets on Flare.`,
      },
      { property: "og:title", content: pageTitle("Pitch") },
      {
        property: "og:description",
        content:
          "Bet YES or NO in FXRP, settled on-chain by FTSOv2 — and hide which side you took with a zero-knowledge proof.",
      },
    ],
  }),
  component: PitchPage,
});

function PitchPage() {
  return <PitchDeck />;
}
