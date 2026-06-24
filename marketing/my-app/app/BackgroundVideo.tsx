"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const SEAM_WINDOW = 0.35;

function subscribe(callback: () => void) {
  const mq = window.matchMedia(REDUCE_MOTION_QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getSnapshot() {
  return window.matchMedia(REDUCE_MOTION_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export default function BackgroundVideo() {
  const reduceMotion = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const seamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (reduceMotion) {
      video.pause();
    } else {
      void video.play().catch(() => {});
    }
  }, [reduceMotion]);

  useEffect(() => {
    const video = videoRef.current;
    const seam = seamRef.current;
    if (!video || !seam) return;

    let rafId = 0;

    const tick = () => {
      const { duration, currentTime } = video;
      if (Number.isFinite(duration) && duration > 0) {
        const endProx = Math.min(
          Math.max((currentTime - (duration - SEAM_WINDOW)) / SEAM_WINDOW, 0),
          1,
        );
        const startProx = Math.min(
          Math.max((SEAM_WINDOW - currentTime) / SEAM_WINDOW, 0),
          1,
        );
        seam.style.opacity = String(Math.max(endProx, startProx));
      }
      rafId = requestAnimationFrame(tick);
    };

    const handlePlay = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };

    const handlePause = () => {
      cancelAnimationFrame(rafId);
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);

    // Start loop if video is already playing
    if (!video.paused) {
      handlePlay();
    }

    return () => {
      cancelAnimationFrame(rafId);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
    };
  }, []);

  return (
    <>
      <video
        ref={videoRef}
        className="factory-video"
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
      >
        <source src="/website_background.mp4" type="video/mp4" />
      </video>
      <div className="factory-seam" ref={seamRef} aria-hidden="true" />
    </>
  );
}
