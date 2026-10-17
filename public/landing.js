// OKX-Style Interactive Risk Simulator in Hero Card
(function initRiskSimulator() {
  const buttons = document.querySelectorAll('.risk-toggle-btn');
  const banner = document.getElementById('verdict-outcome');
  const step3 = document.getElementById('sim-step-risk');
  const step4 = document.getElementById('sim-step-settle');

  if (!buttons.length || !banner) return;

  const states = {
    LOW: {
      class: 'low',
      bannerText: '[APPROVED] LOW Risk: CompliR EIP-712 Attestation verified. 1,250 USDC released on Arc.',
      step3Text: 'LOW · Attestation Verified',
      step3Color: '#00d182',
      step4Text: 'Settled on Arc · Tx #0x8f4b…91e2',
      step4Active: true,
      step4Color: '#00d182'
    },
    MEDIUM: {
      class: 'medium',
      bannerText: '[REVIEW] MEDIUM Risk: Review triggered. Payout held in treasury escrow for owner sign-off.',
      step3Text: 'MEDIUM · Review Required',
      step3Color: '#f59e0b',
      step4Text: 'Escrow paused · Awaiting sign-off',
      step4Active: false,
      step4Color: '#f59e0b'
    },
    HIGH: {
      class: 'high',
      bannerText: '[BLOCKED] HIGH Risk: Sanctions / anomaly detected. Transfer blocked automatically.',
      step3Text: 'HIGH · Transfer Blocked',
      step3Color: '#f6465d',
      step4Text: 'Release Aborted · Funds Safe in Vault',
      step4Active: false,
      step4Color: '#f6465d'
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
      nav.style.background = 'rgba(0, 0, 0, 0.95)';
      nav.style.borderColor = '#2d2d2d';
    } else {
      nav.style.background = 'rgba(0, 0, 0, 0.85)';
      nav.style.borderColor = '#222222';
    }
  }
});
