// Shared by the scene editor and the render queue.
(() => {
  const durations = Object.freeze([2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20]);
  // Use Fast durations shared by 540p, 720p and 1080p.
  const automaticDurations = [2, 3, 4, 5, 6, 8, 10, 20];
  const actionBreak =
    /[;.!?\n]+|,\s*(?:depois|então|em seguida|then|next|after that)\b|\s+(?:e depois|e então|em seguida|and then|followed by)\s+/iu;

  function estimateDuration(prompt) {
    const text = prompt.trim();
    if (!text) return null;

    const total = text.match(
      /(?:duração(?:\s+total)?|duration|total length)\s*(?:[:=]|de\s+|of\s+)?\s*(\d+(?:[.,]\d+)?)\s*(?:segundos?|seconds?|s)\b/iu,
    );
    let seconds;
    if (total) {
      seconds = Number(total[1].replace(",", "."));
    } else {
      seconds = 1;
      for (const beat of text
        .split(actionBreak)
        .filter((part) => part.trim())) {
        const timing = beat.match(
          /(?:por|durante|de|for)\s+(\d+(?:[.,]\d+)?)(?:\s*(?:a|até|to|[-–])\s*(\d+(?:[.,]\d+)?))?\s*(?:segundos?|seconds?|s)\b/iu,
        );
        const words = beat.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
        if (timing)
          seconds += Number((timing[2] ?? timing[1]).replace(",", "."));
        else if (words) seconds += Math.min(4, 1.5 + words / 14);
      }
      seconds = Math.max(3, seconds);
    }
    return (
      automaticDurations.find((duration) => duration >= seconds) ??
      automaticDurations.at(-1)
    );
  }

  function sequenceDuration(seconds) {
    return automaticDurations.find((duration) => duration >= seconds) ?? null;
  }

  const api = { durations, estimateDuration, sequenceDuration };
  if (typeof module !== "undefined") module.exports = api;
  else window.aividDuration = api;
})();
