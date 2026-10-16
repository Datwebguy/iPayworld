const reveal = document.querySelectorAll('.statement, .loop-section, .proof-section, .final-cta, .proof-line');
reveal.forEach((el, i) => el.classList.add('reveal'));
const io = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); } }), { threshold: .16 });
reveal.forEach((el) => io.observe(el));
const hero = document.querySelector('.hero-right');
if (hero && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  hero.addEventListener('pointermove', (event) => { const r = hero.getBoundingClientRect(); const x = (event.clientX-r.left)/r.width-.5; const y = (event.clientY-r.top)/r.height-.5; hero.style.transform = `perspective(900px) rotateY(${x*3}deg) rotateX(${y*-3}deg)`; });
  hero.addEventListener('pointerleave', () => { hero.style.transform = ''; });
}
(async () => {
  const canvas = document.querySelector('#shader-canvas');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    const { createShader } = await import('https://esm.sh/shaders@4.0.4/js?bundle');
    await createShader(canvas, { components: [
      { type: 'LinearGradient', id: 'gradient', props: { colorA: '#10182f', colorB: '#5369e8', angle: 1.2 } },
      { type: 'Aurora', id: 'aurora', props: { colorA: '#c9f36a', colorB: '#5369e8', speed: 0.18, intensity: 0.32 } },
      { type: 'CursorTrail', id: 'cursor', props: { color: '#c9f36a', intensity: 0.22, size: 0.28 } }
    ] }, { disableTelemetry: true });
    document.documentElement.classList.add('shader-ready');
  } catch (error) {
    console.info('WebGPU shader fallback active', error);
  }
})();
