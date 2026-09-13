"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

export const CONVERSATIONAL_THINKING_MS = 4_000;
export const CONVERSATIONAL_TYPING_MS_PER_CHARACTER = 22;
export const CONVERSATIONAL_TYPING_MAX_MS = 3_500;
const SCROLL_BOTTOM_THRESHOLD = 96;

type MotionPhase = "thinking" | "typing" | "complete";

type MotionEntry = {
  id: string;
  startedAt: number;
  readyAt?: number;
  text?: string;
  visibleText: string;
  phase: MotionPhase;
};

export type MotionEntryState = Readonly<MotionEntry>;

export type MotionController = {
  begin: (id: string, startedAt?: number) => void;
  resolve: (id: string, text: string) => void;
  finishAll: () => void;
  cancelAll: () => void;
  get: (id: string) => MotionEntryState | undefined;
  pendingIds: readonly string[];
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isNearBottom(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return true;
  return (
    document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) <=
    SCROLL_BOTTOM_THRESHOLD
  );
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setReduced(media.matches);
    handleChange();
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  return reduced;
}

export function useConversationalMotion(): MotionController {
  const reducedMotion = usePrefersReducedMotion();
  const [entries, setEntries] = useState<Record<string, MotionEntry>>({});
  const entriesRef = useRef(new Map<string, MotionEntry>());
  const queueRef = useRef<string[]>([]);
  const activeIdRef = useRef<string | undefined>(undefined);
  const timeoutRefs = useRef(new Map<string, number>());
  const timerRefs = useRef(new Map<string, number>());
  const disposedRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const startNextRef = useRef<() => void>(() => undefined);

  const publish = useCallback((entry: MotionEntry) => {
    if (disposedRef.current) return;
    entriesRef.current.set(entry.id, entry);
    setEntries((current) => ({ ...current, [entry.id]: entry }));
    if (stickToBottomRef.current && typeof window !== "undefined") {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    }
  }, []);

  const clearTimer = useCallback((id: string) => {
    const timeout = timeoutRefs.current.get(id);
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeoutRefs.current.delete(id);
    const timer = timerRefs.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timerRefs.current.delete(id);
  }, []);

  const removeFromQueue = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((queuedId) => queuedId !== id);
  }, []);

  const complete = useCallback(
    (entry: MotionEntry, text = entry.text ?? "") => {
      clearTimer(entry.id);
      removeFromQueue(entry.id);
      publish({ ...entry, text, visibleText: text, phase: "complete", readyAt: entry.readyAt ?? Date.now() });
      if (activeIdRef.current === entry.id) activeIdRef.current = undefined;
    },
    [clearTimer, publish, removeFromQueue],
  );

  const startTyping = useCallback(
    (entry: MotionEntry) => {
      if (disposedRef.current || entry.text === undefined || activeIdRef.current !== entry.id) return;
      clearTimer(entry.id);
      if (reducedMotion) {
        complete(entry, entry.text);
        startNextRef.current();
        return;
      }

      const text = entry.text;
      if (text.length === 0) {
        complete(entry, text);
        startNextRef.current();
        return;
      }
      const duration = Math.min(
        text.length * CONVERSATIONAL_TYPING_MS_PER_CHARACTER,
        CONVERSATIONAL_TYPING_MAX_MS,
      );
      const chunkSize = Math.max(1, Math.ceil(text.length / Math.max(1, Math.ceil(duration / 22))));
      const startedAt = Date.now();
      let visibleCount = 0;
      const tick = () => {
        if (disposedRef.current || activeIdRef.current !== entry.id) return;
        const elapsed = Date.now() - startedAt;
        visibleCount = Math.min(text.length, Math.max(visibleCount + chunkSize, Math.ceil((elapsed / duration) * text.length)));
        if (visibleCount >= text.length) {
          complete({ ...entry, text, visibleText: text, phase: "typing" }, text);
          startNextRef.current();
          return;
        }
        publish({ ...entry, text, visibleText: text.slice(0, visibleCount), phase: "typing" });
        timerRefs.current.set(entry.id, window.setTimeout(tick, 22));
      };
      publish({ ...entry, phase: "typing", visibleText: "" });
      timerRefs.current.set(entry.id, window.setTimeout(tick, 22));
    },
    [clearTimer, complete, publish, reducedMotion],
  );

  const startNext = useCallback(() => {
    if (disposedRef.current || activeIdRef.current) return;
    const nextId = queueRef.current[0];
    if (!nextId) return;
    const next = entriesRef.current.get(nextId);
    if (next?.text === undefined) return;
    activeIdRef.current = nextId;
    const remaining = Math.max(0, next.startedAt + CONVERSATIONAL_THINKING_MS - Date.now());
    if (remaining > 0) {
      timeoutRefs.current.set(nextId, window.setTimeout(() => {
        timeoutRefs.current.delete(nextId);
        const ready = entriesRef.current.get(nextId);
        if (ready?.text !== undefined) startTyping(ready);
      }, remaining));
      return;
    }
    startTyping(next);
  }, [startTyping]);
  useEffect(() => {
    startNextRef.current = startNext;
  }, [startNext]);

  const begin = useCallback(
    (id: string, startedAt = Date.now()) => {
      const entry: MotionEntry = { id, startedAt, visibleText: "", phase: "thinking" };
      queueRef.current.push(id);
      publish(entry);
      startNext();
    },
    [publish, startNext],
  );

  const resolve = useCallback(
    (id: string, text: string) => {
      const current = entriesRef.current.get(id);
      if (!current) return;
      const ready = { ...current, text, readyAt: Date.now() };
      publish(ready);
      if (!activeIdRef.current) {
        startNext();
        return;
      }
      if (activeIdRef.current !== id) return;
      const remaining = Math.max(0, ready.startedAt + CONVERSATIONAL_THINKING_MS - Date.now());
      if (remaining > 0) {
        clearTimer(id);
        timeoutRefs.current.set(id, window.setTimeout(() => {
          timeoutRefs.current.delete(id);
          const resolved = entriesRef.current.get(id);
          if (resolved?.text !== undefined) startTyping(resolved);
        }, remaining));
      } else {
        startTyping(ready);
      }
    },
    [clearTimer, publish, startNext, startTyping],
  );

  const finishAll = useCallback(() => {
    const unresolvedIds: string[] = [];
    for (const entry of entriesRef.current.values()) {
      if (entry.text !== undefined && entry.phase !== "complete") {
        complete(entry, entry.text);
      } else if (entry.text === undefined) {
        clearTimer(entry.id);
        removeFromQueue(entry.id);
        entriesRef.current.delete(entry.id);
        unresolvedIds.push(entry.id);
      }
    }
    if (unresolvedIds.length > 0) {
      setEntries((current) => {
        const next = { ...current };
        for (const id of unresolvedIds) delete next[id];
        return next;
      });
    }
    queueRef.current = [];
    activeIdRef.current = undefined;
  }, [clearTimer, complete, removeFromQueue]);

  const cancelAll = useCallback(() => {
    disposedRef.current = true;
    for (const id of timeoutRefs.current.keys()) clearTimer(id);
    for (const id of timerRefs.current.keys()) clearTimer(id);
    timeoutRefs.current.clear();
    timerRefs.current.clear();
    queueRef.current = [];
    activeIdRef.current = undefined;
  }, [clearTimer]);

  useEffect(() => {
    disposedRef.current = false;
    const handleScroll = () => {
      stickToBottomRef.current = isNearBottom();
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      cancelAll();
    };
  }, [cancelAll]);

  return useMemo(
    () => ({
      begin,
      resolve,
      finishAll,
      cancelAll,
      get: (id: string) => entries[id],
      pendingIds: Object.values(entries)
        .filter((entry) => entry.phase !== "complete")
        .map((entry) => entry.id),
    }),
    [begin, cancelAll, entries, finishAll, resolve],
  );
}

export function ConversationalThinkingBubble() {
  return (
    <div className="conversational-turn omnis-turn conversational-thinking-turn">
      <div className="omnis-avatar" aria-hidden="true">
        <Image
          src="/brand/useomnis-circular-mark-ink.png"
          alt=""
          width={24}
          height={24}
        />
      </div>
      <div className="conversational-turn-content">
        <div
          className="conversational-thinking-bubble"
          role="status"
          aria-label="Omnis is thinking"
          data-testid="omnis-thinking"
        >
          <span className="conversational-thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="sr-only">Omnis is thinking</span>
        </div>
      </div>
    </div>
  );
}
