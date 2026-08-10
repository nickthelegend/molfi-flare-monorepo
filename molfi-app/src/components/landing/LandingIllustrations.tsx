import { useId, type ReactNode } from "react";
import { PredictSideLabel } from "@/components/leverx/PredictSideLabel";
import { isRangeTradingEnabled } from "@/lib/predict/instruments";
import { cn } from "@/lib/utils";

function Frame({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <div className={cn("landing-illus-frame", className)}>
      <div className="landing-illus-frame-bar">
        <span className="landing-illus-dot" />
        <span className="landing-illus-dot" />
        <span className="landing-illus-dot" />
        <span className="landing-illus-frame-label">{label}</span>
      </div>
      <div className="landing-illus-frame-body">{children}</div>
    </div>
  );
}

/**
 * Diagram of how a market resolves: price path against a strike, coloured by
 * which side is winning.
 *
 * Deliberately has NO numbers on it. It used to be captioned "Live chart" and
 * show "Now $67,842" — a hardcoded figure that contradicted the app's own BTC
 * price two clicks away, which reads as fabricated data rather than as the
 * explanatory diagram it actually is.
 */
export function LandingChartIllustration() {
  const bgId = useId();

  return (
    <Frame label="How a market resolves">
      <svg viewBox="0 0 480 280" className="landing-illus-svg" role="img" aria-label="Price chart crossing target">
        <defs>
          <linearGradient id={bgId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-surface)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="var(--color-card)" stopOpacity="0.2" />
          </linearGradient>
        </defs>
        <rect width="480" height="280" fill={`url(#${bgId})`} rx="8" />
        {[60, 110, 160, 210].map((y) => (
          <line key={y} x1="24" y1={y} x2="456" y2={y} stroke="var(--color-border)" strokeWidth="1" opacity="0.5" />
        ))}
        <line x1="24" y1="140" x2="456" y2="140" stroke="#eab308" strokeWidth="2" strokeDasharray="6 4" />
        <text x="32" y="132" fill="#eab308" fontSize="10" fontFamily="JetBrains Mono">
          Target
        </text>
        <polyline
          points="24,175 80,168 130,155 180,142 220,138 260,125 300,118 340,108 380,95 420,88 456,82"
          fill="none"
          stroke="#38ef7d"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <polyline
          points="24,175 80,168 130,155 180,142"
          fill="none"
          stroke="#ef5350"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <circle cx="456" cy="82" r="4" fill="#38ef7d" />
        <rect x="360" y="24" width="108" height="52" rx="6" fill="var(--color-card)" stroke="var(--color-border)" />
        <text x="372" y="44" fill="var(--color-muted-foreground)" fontSize="9" fontFamily="Barlow">
          Now
        </text>
        <text x="372" y="62" fill="var(--color-foreground)" fontSize="13" fontWeight="600" fontFamily="JetBrains Mono">
          above
        </text>
        <rect x="24" y="228" width="72" height="22" rx="4" fill="#38ef7d" fillOpacity="0.18" />
        <text x="32" y="243" fill="#38ef7d" fontSize="10" fontWeight="600" fontFamily="Barlow">
          Winning
        </text>
        <rect x="104" y="228" width="72" height="22" rx="4" fill="var(--color-surface)" stroke="var(--color-border)" />
        <text x="112" y="243" fill="var(--color-muted-foreground)" fontSize="10" fontFamily="JetBrains Mono">
          Private
        </text>
      </svg>
    </Frame>
  );
}

/** UP / DOWN / RANGE market cards. */
export function LandingMarketsIllustration() {
  const cards = (
    [
      { side: "up", color: "#38ef7d", strike: "$95,000", premium: "42¢" },
      { side: "down", color: "#ef5350", strike: "$95,000", premium: "38¢" },
      { side: "range", color: "var(--color-accent)", strike: "$94k–96k", premium: "55¢" },
    ] as const
  ).filter((card) => isRangeTradingEnabled() || card.side !== "range");

  return (
    <Frame label="Markets">
      <div className="landing-illus-markets">
        {cards.map((card) => (
          <div key={card.side} className="landing-illus-market-card">
            <span className="landing-illus-market-side" style={{ color: card.color }}>
              <PredictSideLabel side={card.side} />
            </span>
            <span className="landing-illus-market-strike">{card.strike}</span>
            <span className="landing-illus-market-premium">{card.premium}</span>
            <div className="landing-illus-market-spark" aria-hidden>
              <svg viewBox="0 0 120 32" preserveAspectRatio="none">
                <polyline
                  points={
                    card.side === "down"
                      ? "0,8 30,12 60,18 90,24 120,28"
                      : card.side === "range"
                        ? "0,16 30,14 60,18 90,14 120,16"
                        : "0,28 30,22 60,16 90,10 120,6"
                  }
                  fill="none"
                  stroke={card.color}
                  strokeWidth="2"
                />
              </svg>
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/**
 * Diagram of the LP vault: deposit, earn a share of the fee, withdraw.
 *
 * The figures are gone. This showed "Pool size $1.24M" and "+4.2% this month"
 * — invented numbers, on the pitch deck, for a vault whose real TVL is on
 * /vault and is a great deal smaller. The real number belongs there, not here.
 */
export function LandingVaultIllustration() {
  const fillId = useId();

  return (
    <Frame label="Pool">
      <div className="landing-illus-vault">
        <div className="landing-illus-vault-stat">
          <span className="landing-illus-vault-label">Pool size</span>
          <span className="landing-illus-vault-value">FXRP</span>
          <span className="landing-illus-vault-sub">grows with trading fees</span>
        </div>
        <svg viewBox="0 0 432 100" className="landing-illus-vault-chart" aria-hidden>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0,72 Q54,68 108,58 T216,42 T324,28 T432,18 L432,100 L0,100 Z"
            fill={`url(#${fillId})`}
          />
          <polyline
            points="0,72 54,68 108,58 162,52 216,42 270,36 324,28 378,22 432,18"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2"
          />
        </svg>
        <div className="landing-illus-vault-actions">
          <span className="landing-illus-vault-btn landing-illus-vault-btn--primary">Deposit FXRP</span>
          <span className="landing-illus-vault-btn">Withdraw</span>
        </div>
      </div>
    </Frame>
  );
}


