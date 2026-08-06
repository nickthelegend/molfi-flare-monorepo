import { createFileRoute } from "@tanstack/react-router";
import { GuideStorybook } from "@/components/GuideStorybook";
import { pageTitle } from "@/lib/brand";
import { ui } from "@/lib/copy";
import { routePendingOptions } from "@/lib/router/route-options";

export const Route = createFileRoute("/_app/guide")({
  ...routePendingOptions,
  loader: () => null,
  head: () => ({
    meta: [
      { title: pageTitle("How it works") },
      {
        name: "description",
        content: `${ui.appTagline}. Learn how FXRP-collateralized bets, FTSOv2 settlement, and the LP vault work on Flare Coston2.`,
      },
    ],
  }),
  component: GuidePage,
});

function GuidePage() {
  return <GuideStorybook />;
}
