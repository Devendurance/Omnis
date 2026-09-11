import {
  ArrowUpRight,
  Check,
  Fingerprint,
  ShieldCheck,
  SlidersHorizontal,
  FileCheck2,
  Layers3,
  ArrowRight,
} from "lucide-react";
import { ActionLink, Wordmark } from "@/components/ui";
import { MarketingNavigation } from "@/components/navigation";
import { LandingMotion } from "@/components/landing-motion";
import { HeroAtmosphere } from "@/components/hero-atmosphere";
import {
  AmbientMotionToggle,
  AmbientVideo,
  MotionProvider,
} from "@/components/ambient-motion";
import Link from "next/link";

export default function Home() {
  return (
    <MotionProvider>
      <MarketingNavigation />
      <main id="main" tabIndex={-1} className="landing">
        <span className="landing-anchor-sentinel" data-landing-sentinel="hero" aria-hidden="true" />
        <section
          className="hero cosmic"
          data-stack-panel
          data-stack-theme="cosmic"
        >
          <span className="stack-edge" data-sheet-edge aria-hidden="true" />
          <AmbientVideo variant="hero" />
          <div className="cosmic-field" aria-hidden="true" />
          <HeroAtmosphere />
          <div className="hero-identity" data-hero-reveal>
            <h1 className="hero-title">
              <Wordmark tone="light" priority />
            </h1>
            <p className="hero-tagline" data-hero-reveal>
              tell omnis what needs to get paid.
              <br />
              {" "}it handles the rest.
            </p>
            <p className="hero-descriptor" data-hero-reveal>
              A financial execution agent that acts
              <br className="desktop-break" /> within your budget and rules.
            </p>
            <span data-hero-reveal>
              <ActionLink href="/app" variant="light">
              start a task
              </ActionLink>
            </span>
          </div>
          <AmbientMotionToggle />
        </section>

        <span className="landing-anchor-sentinel" data-landing-sentinel="policy" aria-hidden="true" />
        <section
          id="policy"
          className="landing-panel editorial"
          data-stack-panel
          data-stack-theme="editorial"
        >
          <span className="stack-edge" data-sheet-edge aria-hidden="true" />
          <div className="panel-inner">
            <div className="section-kicker">
              <span className="eyebrow">01 / the policy</span>
              <SlidersHorizontal size={21} aria-hidden="true" />
            </div>
            <div className="editorial-split" data-reveal-group>
              <div data-reveal>
                <h2>
                  Delegate the work.
                  <br />
                  <span className="soft-ink">Keep the control.</span>
                </h2>
                <p className="section-intro">
                  Give Omnis the task, budget, and rules. It handles the
                  financial work and brings back the proof.
                </p>
                <ActionLink href="/app/policies" variant="outline">
                  see the policy
                </ActionLink>
              </div>
              <div className="policy-manifest" data-reveal>
                <p className="eyebrow">this is what omnis may do</p>
                <div>
                  <span>the task</span>
                  <p>Say what needs to happen.</p>
                </div>
                <div>
                  <span>the budget</span>
                  <p>Define what it may spend.</p>
                </div>
                <div>
                  <span>the rules</span>
                  <p>Make the boundary explicit.</p>
                </div>
                <footer>
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span>Your approval before the final payment.</span>
                </footer>
              </div>
            </div>
            <div className="section-foot">
              <span>possibility, with a boundary.</span>
              <span>
                intent <ArrowRight size={14} aria-hidden="true" /> policy
              </span>
            </div>
          </div>
        </section>

        <span className="landing-anchor-sentinel" data-landing-sentinel="services" aria-hidden="true" />
        <section
          id="services"
          className="landing-panel cosmic service-section"
          data-stack-panel
          data-stack-theme="cosmic"
        >
          <span className="stack-edge" data-sheet-edge aria-hidden="true" />
          <div className="panel-inner">
            <div className="section-kicker">
              <span className="eyebrow">02 / the service</span>
              <Layers3 size={21} aria-hidden="true" />
            </div>
            <div className="service-story" data-reveal-group>
              <div className="service-copy" data-reveal>
                <h2>
                  Every spend.
                  <br />
                  For a reason.
                </h2>
                <p className="section-intro">
                  An agent can buy what it needs without receiving unlimited
                  authority. A useful capability, a clear price, a purpose you
                  can inspect.
                </p>
                <ActionLink href="/app/services" variant="light">
                  explore services
                </ActionLink>
              </div>
              <div
                className="service-diagram"
                data-reveal
                aria-label="Service selection considers the task, capability, budget, and result"
              >
                <span className="orbit orbit-one" aria-hidden="true" />
                <span className="orbit orbit-two" aria-hidden="true" />
                <div className="diagram-core">
                  <span className="eyebrow">the mandate</span>
                  <span>
                    task
                    <br />
                    budget
                    <br />
                    rules
                  </span>
                </div>
                <span className="orbit-label orbit-label-top">capability</span>
                <span className="orbit-label orbit-label-right">
                  within budget
                </span>
                <span className="orbit-label orbit-label-bottom">
                  useful result
                </span>
              </div>
            </div>
            <div className="section-foot">
              <span>resourceful. accountable. bounded.</span>
              <span>
                policy <ArrowRight size={14} aria-hidden="true" /> service
              </span>
            </div>
          </div>
        </section>

        <span className="landing-anchor-sentinel" data-landing-sentinel="approval" aria-hidden="true" />
        <section
          id="approval"
          className="landing-panel editorial"
          data-stack-panel
          data-stack-theme="editorial"
        >
          <span className="stack-edge" data-sheet-edge aria-hidden="true" />
          <div className="panel-inner">
            <div className="section-kicker">
              <span className="eyebrow">03 / the approval</span>
              <Fingerprint size={22} aria-hidden="true" />
            </div>
            <div className="approval-story" data-reveal-group>
              <p className="eyebrow">a deliberate pause</p>
              <h2>
                Some decisions
                <br />
                stay with you.
              </h2>
              <p className="section-intro">
                Approval is a product state. Before the final payment, see
                exactly what you are approving, why it needs your decision, and
                what has already happened.
              </p>
              <div className="approval-points" data-reveal-stagger>
                <span>
                  <Check size={17} aria-hidden="true" /> exact amount
                </span>
                <span>
                  <Check size={17} aria-hidden="true" /> clear recipient
                </span>
                <span>
                  <Check size={17} aria-hidden="true" /> visible financial
                  effect
                </span>
              </div>
              <ActionLink href="/app/approvals" variant="outline">
                watch the approval boundary
              </ActionLink>
            </div>
            <div className="section-foot">
              <span>one clear decision, before money moves.</span>
              <span>
                service <ArrowRight size={14} aria-hidden="true" /> approval
              </span>
            </div>
          </div>
        </section>

        <span className="landing-anchor-sentinel" data-landing-sentinel="settlement" aria-hidden="true" />
        <section
          id="settlement"
          className="landing-panel cosmic settlement-section"
          data-stack-panel
          data-stack-theme="cosmic"
        >
          <span className="stack-edge" data-sheet-edge aria-hidden="true" />
          <div className="panel-inner">
            <div className="section-kicker">
              <span className="eyebrow">04 / the settlement</span>
              <ArrowUpRight size={22} aria-hidden="true" />
            </div>
            <div className="settlement-story">
              <span className="eyebrow">the outcome is the point</span>
              <h2>
                From intention
                <br />
                to completion.
              </h2>
              <p className="section-intro">
                The payment, its state, and the next step belong in one story.
                Network details stay available without becoming the job.
              </p>
              <div
                className="settlement-path"
                data-reveal
                aria-label="Planned settlement process"
              >
                <span>review</span>
                <ArrowRight aria-hidden="true" size={18} />
                <span>approve</span>
                <ArrowRight aria-hidden="true" size={18} />
                <span>settle</span>
              </div>
              <p className="subtle-copy">
                Planned infrastructure: Privy for the human wallet layer.
                <br />
                Arc and Circle for settlement. Hedera for machine commerce.
              </p>
            </div>
            <div className="section-foot">
              <span>the route stays clear. the details stay inspectable.</span>
              <span>
                approval <ArrowRight size={14} aria-hidden="true" /> settlement
              </span>
            </div>
          </div>
        </section>

        <span className="landing-anchor-sentinel" data-landing-sentinel="proof" aria-hidden="true" />
        <section
          id="proof"
          className="landing-panel editorial proof-section"
          data-stack-panel
          data-stack-theme="editorial"
        >
          <span className="stack-edge" data-sheet-edge aria-hidden="true" />
          <div className="panel-inner">
            <div className="section-kicker">
              <span className="eyebrow">05 / the proof</span>
              <FileCheck2 size={22} aria-hidden="true" />
            </div>
            <div className="editorial-split">
              <div>
                <h2>
                  The whole story.
                  <br />
                  <span className="soft-ink">One proof.</span>
                </h2>
                <p className="section-intro">
                  A financial task is not finished until the payment is settled
                  and explainable. One record connects what you asked for with
                  what happened.
                </p>
                <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                  <ActionLink href="/app/proof" variant="outline">
                  explore proof
                  </ActionLink>
                  <ActionLink href="/evidence" variant="outline">
                  verified demo evidence
                  </ActionLink>
                </div>
              </div>
              <div className="proof-outline" data-reveal>
                <p className="eyebrow">inside a proof bundle</p>
                {[
                  "original task & structured plan",
                  "policy & budget",
                  "service purchase & result",
                  "human approval",
                  "settlement & transaction evidence",
                ].map((item, index) => (
                  <div key={item} data-proof-row>
                    <span className="proof-line-marker" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>{item}</span>
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </div>
                ))}
                <p className="proof-outline-caption">
                  A record of the work. Not just a receipt.
                </p>
              </div>
            </div>
          </div>
        </section>

        <span className="landing-anchor-sentinel" data-landing-sentinel="cta" aria-hidden="true" />
        <section
          className="landing-cta cosmic"
          data-motion-cta
          data-stack-panel
          data-stack-theme="cosmic"
        >
          <span className="stack-edge" data-sheet-edge aria-hidden="true" />
          <AmbientVideo variant="cta" />
          <span className="eyebrow">task. budget. rules.</span>
          <h2>
            What needs
            <br />
            to get paid?
          </h2>
          <span data-reveal>
            <ActionLink href="/app" variant="light">
            tell omnis what needs to get paid
            </ActionLink>
          </span>
          <p>Plan in the interface. Start a configured wallet activity check explicitly.</p>
          <AmbientMotionToggle />
        </section>
      </main>
      <footer className="site-footer cinematic-footer">
        <picture className="cinematic-footer-media">
          <source srcSet="/media/useomnis-footer-astronaut.avif" type="image/avif" />
          <source srcSet="/media/useomnis-footer-astronaut.webp" type="image/webp" />
          <img
            src="/media/useomnis-footer-astronaut.jpg"
            alt=""
            loading="lazy"
            decoding="async"
          />
        </picture>
        <div className="cinematic-footer-veil" aria-hidden="true" />
        <div className="cinematic-footer-inner">
          <div className="cinematic-footer-topline" data-footer-reveal>
            <a href="#main" data-landing-anchor aria-label="useOmnis, back to top">
              <Wordmark compact tone="light" />
            </a>
            <span>bounded financial execution for humans and agents.</span>
          </div>

          <nav className="cinematic-footer-content" aria-label="Footer navigation" data-footer-reveal>
            <div className="footer-link-column" data-footer-reveal>
              <h2>navigate</h2>
              <a href="#main" data-landing-anchor>top</a>
              <a href="#policy" data-landing-anchor>policy</a>
              <a href="#services" data-landing-anchor>services</a>
              <a href="#approval" data-landing-anchor>approval</a>
              <a href="#settlement" data-landing-anchor>settlement</a>
              <a href="#proof" data-landing-anchor>proof</a>
            </div>
            <div className="footer-link-column" data-footer-reveal>
              <h2>workspace</h2>
              <Link href="/app">start a task</Link>
              <Link href="/app/tasks">tasks</Link>
              <Link href="/evidence">verified evidence</Link>
              <Link href="/app/policies">policies</Link>
              <Link href="/app/agents">agents</Link>
              <Link href="/app/services">services</Link>
              <Link href="/app/approvals">approvals</Link>
              <Link href="/app/proof">proof</Link>
              <Link href="/app/wallet">wallet</Link>
            </div>
            <div className="footer-link-column footer-link-column-muted" data-footer-reveal>
              <h2>elsewhere</h2>
              <span aria-disabled="true">X <small>coming later</small></span>
              <span aria-disabled="true">LinkedIn <small>coming later</small></span>
              <span aria-disabled="true">newsletter <small>coming later</small></span>
              <Link className="footer-cta" href="/app">
                start a task <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </nav>

          <div className="cinematic-footer-wordmark" data-footer-reveal aria-hidden="true">
            <Wordmark tone="light" />
          </div>
        </div>
      </footer>
      <LandingMotion />
    </MotionProvider>
  );
}
