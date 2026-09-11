"use client";

import Lenis from "lenis";
import { useAmbientMotion } from "@/components/ambient-motion";
import { useEffect } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const STACK_QUERY =
  "(min-width: 1024px) and (min-height: 720px) and (pointer: fine) and (prefers-reduced-motion: no-preference)";

function setNavState(
  header: HTMLElement,
  root: HTMLElement,
  panel: HTMLElement,
) {
  const theme = panel.dataset.stackTheme === "editorial" ? "editorial" : "cosmic";
  const section = panel.id || "hero";
  header.dataset.navTheme = theme;
  header.dataset.activeSection = section;
  root.dataset.activeSection = section;

  document.querySelectorAll<HTMLElement>("[data-nav-target]").forEach((link) => {
    const active = link.dataset.navTarget === section;
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}

type LandingAnchor = "main" | "hero" | "policy" | "services" | "approval" | "settlement" | "proof" | "cta";

export function LandingMotion() {
  const { allowed } = useAmbientMotion();

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const root = document.querySelector<HTMLElement>(".landing");
    const header = document.querySelector<HTMLElement>(".marketing-header");
    if (!root || !header) return;

    const panels = Array.from(
      root.querySelectorAll<HTMLElement>("[data-stack-panel]"),
    );
    if (!panels.length) return;

    let lenis: Lenis | undefined;
    let ticker: ((time: number) => void) | undefined;
    let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
    let destroyLenis = () => undefined;
    let keyboardMode = false;
    let stackEnabled = false;
    const stackMedia = window.matchMedia(STACK_QUERY);
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    const motionAllowed =
      allowed &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
      !window.matchMedia("(prefers-reduced-transparency: reduce)").matches &&
      !window.matchMedia("(forced-colors: active)").matches &&
      connection?.saveData !== true &&
      !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");

    root.dataset.lenisState = motionAllowed ? "initializing" : "disabled";
    root.dataset.stackEnabled = "false";
    root.dataset.stackMode = "flow";
    root.dataset.activeSection = "hero";
    header.dataset.navTheme = "cosmic";
    header.dataset.activeSection = "hero";

    panels.forEach((panel, index) => {
      panel.dataset.stackIndex = String(index);
      panel.dataset.stackReady = "true";
    });
    setNavState(header, root, panels[0]);

    const context = gsap.context(() => {
      panels.forEach((panel) => {
        const anchorId = panel.id ||
          (panel.classList.contains("hero")
            ? "hero"
            : panel.classList.contains("landing-cta")
              ? "cta"
              : "");
        const trigger =
          (anchorId &&
            root.querySelector<HTMLElement>(
              `[data-landing-sentinel="${anchorId}"]`,
            )) || panel;
        ScrollTrigger.create({
          trigger,
          start: "top 55px",
          end: "top -55px",
          onEnter: () => setNavState(header, root, panel),
          onEnterBack: () => setNavState(header, root, panel),
        });
      });

      if (!motionAllowed) return;

      const hero = root.querySelector<HTMLElement>(".hero-identity");
      if (hero) {
        gsap.fromTo(
          hero,
          { opacity: 0, y: 18 },
          {
            opacity: 1,
            y: 0,
            duration: 0.95,
            delay: 0.1,
            ease: "power3.out",
          },
        );
      }

      gsap.fromTo(
        root.querySelectorAll<HTMLElement>(
          "[data-hero-reveal]:not(.hero-identity)",
        ),
        { opacity: 0, y: 12 },
        {
          opacity: 1,
          y: 0,
          duration: 0.55,
          stagger: 0.08,
          delay: 0.32,
          ease: "power3.out",
        },
      );

      panels.forEach((panel) => {
        const edge = panel.querySelector<HTMLElement>("[data-sheet-edge]");
        if (edge) {
          gsap.fromTo(
            edge,
            { scaleX: 0 },
            {
              scaleX: 1,
              duration: 0.65,
              ease: "power3.out",
              scrollTrigger: {
                trigger: panel,
                start: "top 94%",
                once: true,
              },
            },
          );
        }

        if (
          panel.classList.contains("hero") ||
          panel.classList.contains("landing-cta")
        ) {
          return;
        }

        const revealTargets = Array.from(
          panel.querySelectorAll<HTMLElement>(
            ".section-kicker, h2, .section-intro, [data-reveal], [data-reveal-stagger] > *, .section-foot",
          ),
        ).filter((element, index, all) => all.indexOf(element) === index);

        gsap.fromTo(
          revealTargets,
          { opacity: 0, y: 24 },
          {
            opacity: 1,
            y: 0,
            duration: 0.72,
            stagger: 0.065,
            ease: "power3.out",
            overwrite: "auto",
            scrollTrigger: {
              trigger: panel,
              start: "top 76%",
              once: true,
            },
          },
        );
      });

      gsap.fromTo(
        root.querySelectorAll<HTMLElement>("[data-proof-row]"),
        { opacity: 0, x: 14 },
        {
          opacity: 1,
          x: 0,
          duration: 0.45,
          stagger: 0.07,
          ease: "power2.out",
          scrollTrigger: {
            trigger: ".proof-outline",
            start: "top 72%",
            once: true,
          },
        },
      );

      gsap.to(root.querySelector(".orbit-one"), {
        rotate: 18,
        ease: "none",
        scrollTrigger: {
          trigger: ".service-section",
          start: "top bottom",
          end: "bottom top",
          scrub: 0.8,
        },
      });
      gsap.to(root.querySelector(".orbit-two"), {
        rotate: -12,
        ease: "none",
        scrollTrigger: {
          trigger: ".service-section",
          start: "top bottom",
          end: "bottom top",
          scrub: 0.8,
        },
      });

      const settlement = root.querySelector<HTMLElement>(".settlement-path");
      if (settlement) {
        gsap.fromTo(
          settlement,
          { opacity: 0, clipPath: "inset(0 100% 0 0)" },
          {
            opacity: 1,
            clipPath: "inset(0 0% 0 0)",
            duration: 0.8,
            ease: "power3.out",
            scrollTrigger: {
              trigger: settlement,
              start: "top 78%",
              once: true,
            },
          },
        );
      }

      const cta = root.querySelector<HTMLElement>("[data-motion-cta]");
      if (cta) {
        gsap.fromTo(
          cta.querySelectorAll<HTMLElement>("[data-reveal], h2, p"),
          { opacity: 0, y: 16 },
          {
            opacity: 1,
            y: 0,
            duration: 0.6,
            stagger: 0.08,
            ease: "power3.out",
            scrollTrigger: { trigger: cta, start: "top 78%", once: true },
          },
        );
      }

      const footer = document.querySelector<HTMLElement>(".cinematic-footer");
      if (footer) {
        gsap.fromTo(
          footer.querySelectorAll<HTMLElement>("[data-footer-reveal]"),
          { opacity: 0, y: 18 },
          {
            opacity: 1,
            y: 0,
            duration: 0.72,
            stagger: 0.08,
            ease: "power3.out",
            scrollTrigger: {
              trigger: footer,
              start: "top 78%",
              once: true,
            },
          },
        );
      }
    }, root);

    const syncStackState = () => {
      stackEnabled = motionAllowed && stackMedia.matches && !keyboardMode;
      root.dataset.stackEnabled = String(stackEnabled);
      root.dataset.stackMode = stackEnabled ? "sticky" : "flow";
      if (stackEnabled) {
        panels.forEach((panel) => {
          panel.style.setProperty(
            "--stack-index",
            panel.dataset.stackIndex ?? "0",
          );
        });
      } else {
        panels.forEach((panel) => panel.style.removeProperty("--stack-index"));
      }
      ScrollTrigger.refresh();
    };

    stackMedia.addEventListener("change", syncStackState);
    syncStackState();

    const panelForAnchor = (anchor: LandingAnchor) => {
      if (anchor === "main") return panels[0];
      if (anchor === "hero") return panels[0];
      if (anchor === "cta") return root.querySelector<HTMLElement>(".landing-cta") ?? panels[panels.length - 1];
      return root.querySelector<HTMLElement>(`#${anchor}`) ?? panels[0];
    };

    const anchorTop = (anchor: LandingAnchor) => {
      if (anchor === "main" || anchor === "hero") return 0;
      const sentinel = root.querySelector<HTMLElement>(
        `[data-landing-sentinel="${anchor}"]`,
      );
      const element = sentinel ?? panelForAnchor(anchor);
      return Math.max(0, element.getBoundingClientRect().top + window.scrollY);
    };

    const navigateToAnchor = (
      anchor: LandingAnchor,
      updateHash = true,
      immediate = false,
    ) => {
      const headerOffset = header.getBoundingClientRect().height + 8;
      const destination = Math.max(0, anchorTop(anchor) - headerOffset);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (updateHash) {
        const hash = anchor === "main" ? "main" : anchor;
        window.history.pushState(null, "", `#${hash}`);
      }

      if (immediate) {
        window.scrollTo({ top: destination, behavior: "auto" });
      } else if (lenis && motionAllowed && !keyboardMode && !reduced) {
        lenis.scrollTo(destination, { duration: 0.45, force: true });
      } else {
        window.scrollTo({
          top: destination,
          behavior: reduced ? "auto" : "smooth",
        });
      }

      const panel = panelForAnchor(anchor);
      if (panel) setNavState(header, root, panel);
    };

    const onAnchorClick = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLAnchorElement>(
        "a[data-landing-anchor]",
      );
      if (!target || !target.hash || target.origin !== window.location.origin) return;
      const anchor = (target.hash.slice(1) || "main") as LandingAnchor;
      if (!["main", "hero", "policy", "services", "approval", "settlement", "proof", "cta"].includes(anchor)) return;
      event.preventDefault();
      navigateToAnchor(anchor, true, Boolean(target.closest(".cinematic-footer")));
    };
    document.addEventListener("click", onAnchorClick);

    const onHashChange = () => {
      const anchor = (window.location.hash.slice(1) || "main") as LandingAnchor;
      if (["main", "hero", "policy", "services", "approval", "settlement", "proof", "cta"].includes(anchor)) {
        navigateToAnchor(anchor, false);
      }
    };
    window.addEventListener("hashchange", onHashChange);

    if (motionAllowed) {
      lenis = new Lenis({
        lerp: 0.085,
        smoothWheel: true,
        syncTouch: false,
        autoRaf: false,
        anchors: false,
        respectReducedMotion: true,
      });
      const onLenisScroll = () => ScrollTrigger.update();
      lenis.on("scroll", onLenisScroll);
      ticker = (time) => lenis?.raf(time * 1000);
      gsap.ticker.add(ticker);
      gsap.ticker.lagSmoothing(0);
      root.dataset.lenisState = "ready";

      if (window.location.hash) {
        requestAnimationFrame(() => {
          const anchor = (window.location.hash.slice(1) || "main") as LandingAnchor;
          if (["main", "hero", "policy", "services", "approval", "settlement", "proof", "cta"].includes(anchor)) {
            navigateToAnchor(anchor, false);
          }
        });
      }

      onKeyDown = (event) => {
        if (event.key !== "Tab" || keyboardMode) return;
        keyboardMode = true;
        const focusTarget = document.activeElement as HTMLElement | null;
        const before = focusTarget?.getBoundingClientRect().top ?? 0;
        syncStackState();
        requestAnimationFrame(() => {
          const after = focusTarget?.getBoundingClientRect().top ?? before;
          if (focusTarget) {
            window.scrollBy({ top: after - before, behavior: "auto" });
          }
        });
      };
      window.addEventListener("keydown", onKeyDown);

      destroyLenis = () => {
        window.removeEventListener("keydown", onKeyDown as EventListener);
        lenis?.off("scroll", onLenisScroll);
        if (ticker) gsap.ticker.remove(ticker);
        lenis?.destroy();
        lenis = undefined;
        root.dataset.lenisState = "destroyed";
      };
    }

    return () => {
      destroyLenis();
      document.removeEventListener("click", onAnchorClick);
      window.removeEventListener("hashchange", onHashChange);
      stackMedia.removeEventListener("change", syncStackState);
      context.revert();
      panels.forEach((panel) => {
        delete panel.dataset.stackIndex;
        delete panel.dataset.stackReady;
        panel.style.removeProperty("--stack-index");
      });
      delete root.dataset.stackEnabled;
      delete root.dataset.stackMode;
      delete root.dataset.activeSection;
      delete root.dataset.lenisState;
      delete header.dataset.navTheme;
      delete header.dataset.activeSection;
    };
  }, [allowed]);

  return null;
}
