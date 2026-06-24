# Design Spec: Seamless Background Video Loop

* **Date:** 2026-06-21
* **Topic:** Improve background video loop transition using requestAnimationFrame to eliminate timeupdate lag and stutters.

---

## 1. Requirements

### Context & Goal
The background video `website_background.mp4` has a visual jump at the loop point. The current fade-to-black mask (`.factory-seam`) relies on the HTML5 `timeupdate` event, which fires too infrequently (4-10 times/sec). This causes the video to loop before the screen is fully masked, creating a visible glitch.

### Success Criteria
1. The black fade-out/fade-in occurs with sub-frame precision (60fps+) exactly at the end/start of the video.
2. No visual stutters, jump cuts, or unmasked frames during the loop transition.
3. Lightweight execution, cleaning up all animation frames when paused or unmounted.

---

## 2. Component Design

### Location
* File: `app/BackgroundVideo.tsx`

### Technical Approach
1. Replace the `timeupdate` event listener with a continuous `requestAnimationFrame` (rAF) loop.
2. The loop will run whenever the video is playing and is active.
3. Calculate the proximity to the loop point on each frame:
   * If `currentTime` is within the last `SEAM_WINDOW` (0.35s) of the duration: ramp opacity from 0 to 1.
   * If `currentTime` is within the first `SEAM_WINDOW` (0.35s) of the duration: ramp opacity from 1 to 0.
   * Otherwise: opacity is 0.

### Code Structure Reference

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

  // If already playing, start the loop
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
