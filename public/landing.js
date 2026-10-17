const ARC_RPC = 'https://rpc.testnet.arc.io';
const USDC = '0x3600000000000000000000000000000000000000';
const DEMO_TREASURY = '0xb3ccbf94b1965844e062bd9ad22df72b9a45ba17';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(resolve => setTimeout(resolve, reduceMotion ? 0 : ms));

async function rpc(method, params = []) {
  const response = await fetch(ARC_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000)
  });
  const json = await response.json();
  if (json.error || typeof json.result !== 'string') throw new Error(json.error?.message || 'Bad RPC response');
  return json.result;
}

/* Sticky nav state and mobile menu */
(function nav() {
  const header = document.getElementById('nav');
  const toggle = document.getElementById('nav-toggle');
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  const setOpen = open => {
    header.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  document.getElementById('nav-links').addEventListener('click', event => { if (event.target.closest('a')) setOpen(false); });
  window.addEventListener('keydown', event => { if (event.key === 'Escape') setOpen(false); });
})();

/* Reveal on scroll */
(function reveal() {
  const items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || reduceMotion) return items.forEach(el => el.classList.add('in'));
  const io = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  items.forEach(el => io.observe(el));
})();

/* Release slip: walks one milestone through the real pipeline for each verdict */
(function slip() {
  const card = document.getElementById('slip');
  if (!card) return;
  const steps = [...card.querySelectorAll('.slip-steps li')];
  const stamp = document.getElementById('slip-stamp');
  const verdictLabel = document.getElementById('slip-verdict');
  const buttons = card.querySelectorAll('.seg button');
  const outcome = {
    LOW: { stamp: 'Released', haltAt: null },
    MEDIUM: { stamp: 'Held for review', haltAt: 1 },
    HIGH: { stamp: 'Blocked', haltAt: 1 }
  };
  let run = 0;

  async function play(verdict) {
    const id = ++run;
    const plan = outcome[verdict];
    card.dataset.verdict = verdict;
    verdictLabel.textContent = verdict;
    stamp.classList.remove('on');
    stamp.textContent = plan.stamp;
    steps.forEach(step => step.className = '');
    for (let i = 0; i < steps.length; i++) {
      if (id !== run) return;
      if (plan.haltAt !== null && i > plan.haltAt) { steps[i].className = 'skipped'; continue; }
      steps[i].className = 'running';
      await wait(i === 1 ? 900 : 520);
      if (id !== run) return;
      steps[i].className = plan.haltAt === i ? 'halt' : 'done';
    }
    await wait(180);
    if (id === run) stamp.classList.add('on');
  }

  buttons.forEach(button => button.addEventListener('click', () => {
    buttons.forEach(b => b.setAttribute('aria-checked', String(b === button)));
    play(button.dataset.verdict);
  }));

  // Start when the slip first scrolls into view
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) { io.disconnect(); setTimeout(() => play('LOW'), reduceMotion ? 0 : 500); }
  }, { threshold: 0.35 });
  io.observe(card);
})();

/* Ticker: duplicate the group once so the -50% loop is seamless */
(function tape() {
  const track = document.getElementById('tape-track');
  if (!track || reduceMotion) return;
  const clone = track.firstElementChild.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  clone.querySelector('.tape-live b')?.classList.add('tape-block-clone');
  track.appendChild(clone);
})();

/* How it works: highlight the step nearest the middle of the viewport */
(function how() {
  const steps = [...document.querySelectorAll('.how-step')];
  const bar = document.getElementById('how-bar');
  const current = document.getElementById('how-current');
  if (!steps.length) return;
  const activate = index => {
    steps.forEach((step, i) => step.classList.toggle('active', i === index));
    if (bar) bar.style.width = `${((index + 1) / steps.length) * 100}%`;
    if (current) current.textContent = steps[index].dataset.i;
  };
  activate(0);
  if (!('IntersectionObserver' in window)) return steps.forEach(s => s.classList.add('active'));
  const io = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) activate(steps.indexOf(entry.target));
  }, { rootMargin: '-45% 0px -45% 0px' });
  steps.forEach(step => io.observe(step));
})();

/* Live Arc data: demo treasury balance and latest block */
(async function live() {
  const balance = document.getElementById('hero-balance');
  const dot = document.getElementById('net-dot');
  const text = document.getElementById('net-text');
  const blockEls = () => [document.getElementById('tape-block'), ...document.querySelectorAll('.tape-block-clone')].filter(Boolean);

  async function tick() {
    try {
      const block = Number(BigInt(await rpc('eth_blockNumber')));
      const label = block.toLocaleString('en-US');
      blockEls().forEach(el => el.textContent = label);
      dot.className = 'dot live';
      text.textContent = `Arc Testnet · block ${label}`;
    } catch {
      dot.className = 'dot bad';
      text.textContent = 'Arc Testnet unreachable';
      blockEls().forEach(el => el.textContent = 'offline');
    }
  }
  tick();
  setInterval(() => { if (!document.hidden) tick(); }, 12_000);

  try {
    const raw = await rpc('eth_call', [{ to: USDC, data: `0x70a08231${DEMO_TREASURY.slice(2).padStart(64, '0')}` }, 'latest']);
    const usdc = Number(BigInt(raw)) / 1e6;
    balance.textContent = `${usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  } catch {
    balance.textContent = 'unavailable';
  }
})();
