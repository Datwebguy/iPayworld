// Native Interactive Particle & Cosmic Grid Canvas
(function initCanvas() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width, height;
  let particles = [];
  let mouse = { x: null, y: null, radius: 150 };

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    createParticles();
  }

  function createParticles() {
    particles = [];
    const count = Math.min(Math.floor((width * height) / 18000), 75);
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        size: Math.random() * 2 + 1,
        alpha: Math.random() * 0.5 + 0.1,
        color: Math.random() > 0.4 ? '16, 185, 129' : '99, 102, 241'
      });
    }
  }

  function render() {
    ctx.clearRect(0, 0, width, height);

    // Draw connecting lines between close particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 120) {
          const alpha = (1 - dist / 120) * 0.12;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(148, 163, 184, ${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }

    // Draw and update particles
    for (const p of particles) {
      // Mouse interaction
      if (mouse.x !== null && mouse.y !== null) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < mouse.radius) {
          const force = (1 - dist / mouse.radius) * 1.5;
          p.x -= (dx / dist) * force;
          p.y -= (dy / dist) * force;
        }
      }

      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x = width;
      if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height;
      if (p.y > height) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.color}, ${p.alpha})`;
      ctx.fill();
    }

    requestAnimationFrame(render);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });
  window.addEventListener('pointerleave', () => {
    mouse.x = null;
    mouse.y = null;
  });

  resize();
  render();
})();

// Interactive Risk Simulator in Hero Card
(function initRiskSimulator() {
  const buttons = document.querySelectorAll('.risk-toggle-btn');
  const banner = document.getElementById('verdict-outcome');
  const step3 = document.getElementById('sim-step-risk');
  const step4 = document.getElementById('sim-step-settle');

  if (!buttons.length || !banner) return;

  const states = {
    LOW: {
      class: 'low',
      bannerText: '✓ LOW Risk: CompliR EIP-712 Attestation verified. 1,250 USDC released on Arc.',
      step3Text: 'LOW · Attestation Verified',
      step3Color: '#34d399',
      step4Text: 'Settled on Arc · Tx #0x8f4b…91e2',
      step4Active: true,
      step4Color: '#34d399'
    },
    MEDIUM: {
      class: 'medium',
      bannerText: '⚠ MEDIUM Risk: Review triggered. Payout held in treasury escrow for owner sign-off.',
      step3Text: 'MEDIUM · Review Required',
      step3Color: '#fbbf24',
      step4Text: 'Escrow paused · Awaiting sign-off',
      step4Active: false,
      step4Color: '#fbbf24'
    },
    HIGH: {
      class: 'high',
      bannerText: '✕ HIGH Risk: Sanctions / anomaly detected. Transfer blocked automatically.',
      step3Text: 'HIGH · Transfer Blocked',
      step3Color: '#f87171',
      step4Text: 'Release Aborted · Funds Safe in Vault',
      step4Active: false,
      step4Color: '#f87171'
    }
  };

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const verdict = btn.dataset.verdict;
      if (!states[verdict]) return;

      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const state = states[verdict];
      banner.className = `verdict-outcome-banner ${state.class}`;
      banner.textContent = state.bannerText;

      if (step3) {
        const textElem = step3.querySelector('.sim-step-text span');
        if (textElem) {
          textElem.textContent = state.step3Text;
          textElem.style.color = state.step3Color;
        }
      }

      if (step4) {
        step4.classList.toggle('active', state.step4Active);
        const textElem = step4.querySelector('.sim-step-text span');
        if (textElem) {
          textElem.textContent = state.step4Text;
          textElem.style.color = state.step4Color;
        }
      }
    });
  });
})();

// Navbar subtle border on scroll
window.addEventListener('scroll', () => {
  const nav = document.querySelector('.landing-nav');
  if (nav) {
    if (window.scrollY > 20) {
      nav.style.background = 'rgba(7, 9, 14, 0.9)';
      nav.style.borderColor = 'rgba(255, 255, 255, 0.12)';
    } else {
      nav.style.background = 'rgba(7, 9, 14, 0.75)';
      nav.style.borderColor = 'rgba(255, 255, 255, 0.08)';
    }
  }
});
