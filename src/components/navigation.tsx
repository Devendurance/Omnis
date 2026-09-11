"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Plus,
  MessagesSquare,
  Activity,
  SlidersHorizontal,
  Aperture,
  Layers3,
  ShieldCheck,
  FileCheck2,
  Wallet,
  Menu,
  X,
  ArrowUpRight,
} from "lucide-react";
import { navigation } from "@/lib/ui-model";
import { containDialogFocus } from "@/lib/dialog-focus";
import { useAuth } from "@/lib/auth";
import { Wordmark } from "./ui";
import { usePreview } from "./preview";

const icons = {
  plus: Plus,
  tasks: MessagesSquare,
  activity: Activity,
  policies: SlidersHorizontal,
  agents: Aperture,
  services: Layers3,
  approvals: ShieldCheck,
  proof: FileCheck2,
  wallet: Wallet,
};

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <>
      {navigation.map((group) => (
        <div className="nav-group" key={group.label}>
          <p className="nav-group-label">{group.label}</p>
          {group.items.map((item) => {
            const Icon = icons[item.icon];
            const active =
              item.href === "/app"
                ? pathname === "/app"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
              >
                <Icon size={17} aria-hidden="true" />
                {item.label}
                {active && (
                  <span className="nav-active-mark" aria-hidden="true" />
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

export function ProductNavigation() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const auth = useAuth();
  const openPreview = usePreview();
  const handleAuthAction = () => {
    if (auth.configured) {
      auth.login();
    } else {
      openPreview("connect wallet");
    }
  };
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  function close(navigated = false) {
    dialog.current?.close();
    setOpen(false);
    if (navigated)
      requestAnimationFrame(() => document.getElementById("main")?.focus());
    else button.current?.focus();
  }
  return (
    <>
      <aside className="sidebar">
        <Link href="/" className="brand-link" aria-label="useOmnis home">
          <Wordmark compact tone="ink" />
        </Link>
        <nav aria-label="Product navigation">
          <NavItems />
        </nav>
        <div className="sidebar-note">
          <span className="preview-dot" /> interface preview
          <p>
            Task. Budget. Rules.
            <br />
            You keep control.
          </p>
        </div>
        <Link href="/" className="back-to-site">
          back to website <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </aside>
      <header className="app-header">
        <div className="app-header-context">
          <button
            ref={button}
            className="icon-button mobile-menu-button"
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls="product-mobile-nav"
            onClick={() => setOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <span className="header-brand">
            <Wordmark compact tone="ink" />
          </span>
          <span className="desktop-crumb">
            workspace <span>/</span>{" "}
            {pathname === "/app" ? "start a task" : pathname.split("/")[2]}
          </span>
        </div>
        {auth.authenticated ? (
          <div className="app-header-auth-group">
            <Link
              href="/app/wallet"
              className="button button-outline app-header-wallet-chip"
              aria-label="View execution wallet"
            >
              <Wallet size={14} aria-hidden="true" />
              <span>
                {auth.primaryExecutionWallet?.address
                  ? `${auth.primaryExecutionWallet.address.slice(0, 6)}...${auth.primaryExecutionWallet.address.slice(-4)}`
                  : "wallet ready"}
              </span>
            </Link>
            <button
              type="button"
              className="button button-outline app-header-logout-btn"
              onClick={() => auth.logout()}
              aria-label="Log out of session"
            >
              log out
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button button-outline app-header-login-btn"
            aria-label="connect wallet"
            onClick={handleAuthAction}
          >
            <Wallet size={15} aria-hidden="true" />
            <span>connect wallet</span>
          </button>
        )}
      </header>
      <dialog
        id="product-mobile-nav"
        className="nav-dialog"
        ref={dialog}
        aria-label="Product navigation"
        onCancel={() => close()}
        onKeyDown={containDialogFocus}
        onClose={() => setOpen(false)}
      >
        <div className="drawer-top">
          <Link href="/" onClick={() => close(true)} aria-label="useOmnis home">
            <Wordmark compact tone="ink" />
          </Link>
          <button
            className="icon-button"
            onClick={() => close()}
            aria-label="Close navigation"
            autoFocus
          >
            <X size={20} />
          </button>
        </div>
        <nav aria-label="Mobile product navigation">
          <NavItems onNavigate={() => close(true)} />
        </nav>
        {auth.authenticated && (
          <div className="drawer-account-actions">
            <Link href="/app/wallet" className="button button-outline" onClick={() => close(true)}>
              <Wallet size={14} aria-hidden="true" /> view wallet
            </Link>
            <button type="button" className="button button-outline" onClick={() => { void auth.logout(); close(); }}>
              log out
            </button>
          </div>
        )}
        <p className="eyebrow drawer-note">interface preview</p>
      </dialog>
    </>
  );
}

export function MarketingNavigation() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  function close() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  const links = [
    { href: "#policy", label: "the policy" },
    { href: "#services", label: "the services" },
    { href: "#proof", label: "the proof" },
  ];
  return (
    <header
      className="marketing-header"
      data-landing-nav
      data-nav-theme="cosmic"
      data-active-section="hero"
    >
      <Link href="/" aria-label="useOmnis home">
        <Wordmark compact tone="auto" />
      </Link>
      <nav className="marketing-links" aria-label="Main navigation">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            data-nav-target={link.href.slice(1)}
            data-landing-anchor
          >
            {link.label}
          </a>
        ))}
      </nav>
      <div className="marketing-actions">
        <Link className="button button-light" href="/app">
          start a task <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
        <button
          className="icon-button marketing-menu-button"
          ref={trigger}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="marketing-mobile-nav"
          onClick={() => setOpen(true)}
        >
            <Menu size={20} aria-hidden="true" />
        </button>
      </div>
      <dialog
        className="nav-dialog marketing-nav-dialog"
        id="marketing-mobile-nav"
        aria-label="Site navigation"
        ref={dialog}
        onCancel={close}
        onKeyDown={containDialogFocus}
        onClose={() => setOpen(false)}
      >
        <div className="drawer-top">
          <Wordmark compact tone="light" />
          <button
            className="icon-button"
            aria-label="Close navigation"
            onClick={close}
            autoFocus
          >
            <X size={20} />
          </button>
        </div>
        <nav>
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              data-nav-target={link.href.slice(1)}
              data-landing-anchor
              onClick={close}
            >
              {link.label}
            </a>
          ))}
          <Link href="/app" onClick={close}>
            start a task <ArrowUpRight size={16} />
          </Link>
        </nav>
      </dialog>
    </header>
  );
}
