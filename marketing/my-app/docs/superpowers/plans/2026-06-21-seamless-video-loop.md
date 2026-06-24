# Seamless Video Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify the background video transition to use a frame-precise `requestAnimationFrame` loop instead of low-frequency `timeupdate` checks, resolving stutters and visible glitches at the loop point.

**Architecture:** We will replace the video time tracking logic in `BackgroundVideo.tsx` with a frame check. We will register play/pause listeners to start/stop the frame tick and ensure all animations clean up on unmount.

**Tech Stack:** React 19, HTML5 Video API, requestAnimationFrame API.

---

### Task 1: Refactor time tracking in `BackgroundVideo.tsx`

**Files:**
* Modify: `app/BackgroundVideo.tsx`

- [ ] **Step 1: Replace useEffect event listener with rAF loop**

Modify the second `useEffect` hook in `app/BackgroundVideo.tsx` (lines 41-62) to clean up `timeupdate` and hook up `requestAnimationFrame` play/pause trackers:

```typescript
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
```

---

### Task 2: Run Verification and Checks

**Files:**
* None

- [ ] **Step 1: Run linter**

Run: `npm run lint`
Expected: Passes with 0 errors/problems.

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Passes and compiles successfully.
