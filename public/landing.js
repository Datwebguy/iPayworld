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
      bannerText: '[APPROVED] Low Risk: Automated compliance cleared. 1,250 USDC released on Arc.',
      step3Text: 'Low Risk · Cleared',
      step3Color: '#00d182',
      step4Text: 'Instant Settlement · 1,250.00 USDC Released',
      step4Active: true,
      step4Color: '#00d182'
    },
    MEDIUM: {
      class: 'medium',
      bannerText: '[REVIEW] Medium Risk: Security review triggered. Payout held in escrow for approval.',
      step3Text: 'Medium Risk · Manual Review',
      step3Color: '#f59e0b',
      step4Text: 'Escrow Paused · Awaiting Approval',
      step4Active: false,
      step4Color: '#f59e0b'
    },
    HIGH: {
      class: 'high',
      bannerText: '[BLOCKED] High Risk: Security anomaly detected. Transfer blocked automatically.',
      step3Text: 'High Risk · Transfer Blocked',
      step3Color: '#f6465d',
      step4Text: 'Release Aborted · Vault Protected',
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

// Live Onchain Arc Balance for Showcase
(async function initLiveLandingStats() {
  const balanceElem = document.getElementById('landing-hero-balance');
  if (!balanceElem) return;
  try {
    const res = await fetch('https://rpc.testnet.arc.io', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: '0x3600000000000000000000000000000000000000', data: '0x70a08231000000000000000000000000b3ccbf94b1965844e062bd9ad22df72b9a45ba17' }, 'latest']
      })
    });
    const json = await res.json();
    if (json.result && json.result !== '0x') {
      const usdc = Number(BigInt(json.result)) / 1e6;
      balanceElem.innerHTML = `$${usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span>USDC</span>`;
    }
  } catch {}
})();

