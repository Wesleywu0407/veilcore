export function createPerformanceGovernor(renderer, canvas, onChange = () => {}) {
  let tier = 2;
  let elapsed = 0;
  let frames = 0;
  let healthyFor = 0;
  canvas.dataset.quality = 'high';

  function apply(nextTier) {
    if (nextTier === tier) return;
    tier = nextTier;
    const cap = tier === 2 ? 1.25 : tier === 1 ? 1 : 0.85;
    renderer.setPixelRatio(Math.min(devicePixelRatio, cap));
    renderer.shadowMap.enabled = tier > 0;
    canvas.dataset.quality = ['low', 'balanced', 'high'][tier];
    onChange(canvas.dataset.quality);
  }

  return {
    update(dt) {
      elapsed += dt;
      frames++;
      if (elapsed < 2) return null;
      const fps = frames / elapsed;
      canvas.dataset.fps = Math.round(fps).toString();
      if (fps < 45 && tier > 0) {
        healthyFor = 0;
        apply(tier - 1);
      } else if (fps < 52 && tier === 2) {
        healthyFor = 0;
        apply(1);
      } else if (fps >= 58) {
        healthyFor += elapsed;
        if (healthyFor >= 10 && tier < 2) {
          apply(tier + 1);
          healthyFor = 0;
        }
      } else {
        healthyFor = 0;
      }
      elapsed = 0;
      frames = 0;
      return fps;
    },
    get tier() { return tier; },
  };
}
