/**
 * Landing page `/`, the public event directory `/events`, and the sandbox
 * provisioner `POST /sandbox` (spec §5.1, §5.11).
 *
 * `/events` is the path from the bare origin to any published event site —
 * name, dates, venue, and a link to the event's public pages. Sandbox orgs'
 * events are excluded: every visitor mints one, so listing them would bury
 * the real events under demo copies.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx, Event } from '../types';
import { GOOGLE_FONTS, fmtDateRange } from '../views/layout';
import { SocialMeta } from '../views/meta';
import { all } from '../lib/db';
import { seedSandbox } from '../lib/seed';
import { claimPooledSandbox, topUpSandboxPool } from '../lib/sandbox-pool';
import { GITHUB_URL } from '../lib/defaults';
import { ProductLogo } from '../views/brand';

const app = new Hono<Ctx>();

const GITHUB = GITHUB_URL;

/* ------------------------------------------------------------------- css */

const CSS = `
  :root{
    --ink:#16171d; --ink2:#555a63; --ink3:#8b857a;
    --paper:#faf8f5; --line:#ece7de; --card:#ffffff;
    --indigo:#4c5fd5; --indigo-dk:#3a4ab8; --indigo-tint:#eef0fb;
    --amber:#ffd43b; --amber-dk:#8a6d00;
    --green:#2f9e5f; --green-tint:#e7f6ee;
    --mono:'IBM Plex Mono',monospace;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:var(--paper);color:var(--ink);font-family:'Space Grotesk',system-ui,sans-serif;}
  a{color:var(--indigo);text-decoration:none;}
  input,textarea,select,button{font-family:inherit;}
  .wrap{max-width:1120px;margin:0 auto;padding:0 32px;}
  .kicker{font-family:var(--mono);font-size:11px;letter-spacing:0.16em;color:var(--indigo);font-weight:600;}
  .btn{display:inline-block;padding:14px 24px;font-size:15px;font-weight:600;cursor:pointer;border:none;font-family:inherit;text-decoration:none;line-height:normal;}
  .btn-primary{background:var(--indigo);color:#fff;box-shadow:0 2px 0 var(--indigo-dk);}
  .btn-ghost{background:#fff;border:1px solid #ded8cd;color:var(--ink);}
  .btn-amber{background:var(--amber);color:var(--ink);box-shadow:0 2px 0 #d4ac00;}
  .btn-outline-light{background:transparent;border:1px solid rgba(255,255,255,0.35);color:#fff;}
  /* the nav CTA carries a short label on a phone — see the 720px block */
  .cta-mini{display:none;}

  /* ------------------------------------------------------------- nav */
  .nav{position:sticky;top:0;z-index:50;background:rgba(250,248,245,0.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);}
  /* section "-inner" classes share their element with .wrap, so they may only
     set vertical padding — a "Npx 0" shorthand would zero .wrap's side padding */
  .nav-inner{display:flex;align-items:center;gap:12px;padding-top:14px;padding-bottom:14px;}
  /* The wordmark is 143px wide — more than half a 320px bar. Rather than hide
     it on a phone, let it shrink: a flex basis of its natural width that is
     allowed to shrink to nothing, with the <img> at width:100%;height:auto so
     it scales instead of squashing. (A percentage max-width on the image alone
     collapses to 0 — the image would be sizing the box that sizes it.) */
  .nav-brand{display:block;flex:0 1 143px;min-width:0;}
  .nav-links{margin-left:36px;display:flex;gap:24px;font-size:14px;}
  .nav-links a{color:var(--ink2);}
  .nav-cta{margin-left:auto;flex:none;display:flex;gap:10px;align-items:center;}
  .nav-cta .signin{font-size:14px;font-weight:600;color:var(--ink);padding:9px 14px;}
  .nav-cta .btn{padding:9px 16px;font-size:13.5px;}

  /* ------------------------------------------------------------ hero */
  .hero{position:relative;overflow:hidden;border-bottom:1px solid var(--line);
    background:
      radial-gradient(ellipse 900px 420px at 78% -10%, rgba(76,95,213,0.10), transparent 60%),
      radial-gradient(circle at 1px 1px, #e4ded2 1px, transparent 0);
    background-size:auto, 26px 26px;}
  .hero-inner{padding-top:88px;text-align:center;}
  .hero h1{margin:18px auto 20px;font-size:clamp(38px,5.4vw,62px);line-height:1.04;letter-spacing:-0.035em;max-width:17ch;}
  .hero h1 em{font-style:normal;position:relative;white-space:nowrap;}
  .hero h1 em::after{content:"";position:absolute;left:-2px;right:-2px;bottom:4px;height:0.34em;background:var(--amber);z-index:-1;}
  .hero p{margin:0 auto 34px;font-size:18px;line-height:1.6;color:var(--ink2);max-width:56ch;}
  .hero-ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;align-items:center;}

  /* hero collage */
  .collage{position:relative;max-width:920px;margin:64px auto -2px;}
  .browser{background:#fff;border:1px solid var(--line);border-bottom:none;box-shadow:0 24px 60px rgba(22,23,29,0.14);}
  .browser-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);background:#f6f3ee;}
  .dot{width:9px;height:9px;border-radius:50%;background:#ddd6ca;}
  .urlbar{margin-left:10px;flex:1;max-width:340px;background:#fff;border:1px solid var(--line);font-family:var(--mono);font-size:10.5px;color:var(--ink3);padding:4px 10px;text-align:left;}
  .queue{padding:18px 22px 26px;text-align:left;}
  .queue-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;}
  .queue-head b{font-size:15px;letter-spacing:-0.01em;}
  .queue-head span{font-family:var(--mono);font-size:10px;letter-spacing:0.12em;color:var(--ink3);}
  .qrow{display:grid;grid-template-columns:1fr 120px 92px 86px;gap:12px;align-items:center;padding:9px 12px;border:1px solid var(--line);border-bottom:none;background:#fff;font-size:13px;}
  .qrow:last-child{border-bottom:1px solid var(--line);}
  .qrow .t{font-weight:600;}
  .qrow .s{color:var(--ink2);font-size:12px;}
  .score{font-family:var(--mono);font-size:11px;font-weight:600;}
  .bar{height:5px;background:#efece5;position:relative;display:block;}
  .bar i{position:absolute;top:0;bottom:0;left:0;background:var(--indigo);}
  .pill{font-family:var(--mono);font-size:9.5px;letter-spacing:0.08em;padding:3px 8px;text-align:center;font-weight:600;}
  .pill.acc{background:var(--green-tint);color:var(--green);}
  .pill.rev{background:var(--indigo-tint);color:var(--indigo);}
  .pill.wait{background:#fdf6dd;color:var(--amber-dk);}
  .float{position:absolute;background:#fff;border:1px solid var(--line);box-shadow:0 16px 40px rgba(22,23,29,0.16);text-align:left;}
  .float-agenda{right:-34px;top:-38px;width:250px;padding:14px;}
  .float-label{font-family:var(--mono);font-size:9.5px;letter-spacing:0.12em;color:var(--ink3);margin-bottom:9px;}
  .mini-grid{display:grid;grid-template-columns:34px 1fr 1fr;gap:4px;font-size:9px;}
  .mini-grid .time{font-family:var(--mono);color:var(--ink3);font-size:8.5px;display:flex;align-items:center;}
  .blk{padding:6px 7px;font-weight:600;line-height:1.25;color:#fff;background:var(--indigo);}
  .blk.b2{background:#7c6bd8;} .blk.b3{background:#3f8f6e;} .blk.warn{background:#fff;border:1.5px solid var(--amber-dk);color:var(--amber-dk);}
  .float-mail{left:-30px;bottom:-30px;width:270px;padding:14px;}
  .mail-line{font-size:11.5px;color:var(--ink2);line-height:1.5;}
  .mail-line b{color:var(--ink);}
  .mail-btns{display:flex;gap:8px;margin-top:10px;}
  .mail-btns span{font-size:11px;font-weight:600;padding:6px 12px;}
  .mail-btns .send{background:var(--indigo);color:#fff;}
  .mail-btns .prev{border:1px solid var(--line);color:var(--ink2);}

  /* -------------------------------------------------------- pipeline */
  .pipeline{border-bottom:1px solid var(--line);background:#fff;}
  .pipeline-inner{display:flex;justify-content:center;padding-top:22px;padding-bottom:22px;flex-wrap:wrap;}
  .pstep{display:flex;align-items:center;}
  .pstep span{font-family:var(--mono);font-size:11px;letter-spacing:0.14em;font-weight:600;color:var(--ink2);padding:6px 4px;}
  .pstep .arr{color:#c9c2b4;padding:0 14px;font-family:var(--mono);}
  .pstep.active span{color:var(--indigo);}

  /* -------------------------------------------------------- features */
  .feature{padding:96px 0;}
  .feature + .feature{border-top:1px solid var(--line);}
  /* minmax(0,…) not 1fr: a wide child (the terminal, the scoring card) must
     scroll or wrap inside its column, never stretch the grid past the page */
  .f-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:72px;align-items:center;}
  .f-grid.rev .f-copy{order:2;} .f-grid.rev .f-vis{order:1;}
  .feature h2{margin:14px 0 14px;font-size:34px;line-height:1.12;letter-spacing:-0.025em;}
  .feature .lede{margin:0 0 24px;font-size:16px;line-height:1.65;color:var(--ink2);}
  .ticks{list-style:none;margin:0;padding:0;display:grid;gap:12px;}
  .ticks li{display:flex;gap:11px;font-size:14.5px;line-height:1.5;color:var(--ink2);}
  .ticks li b{color:var(--ink);font-weight:600;}
  .tick{flex:none;width:18px;height:18px;margin-top:2px;background:var(--indigo-tint);color:var(--indigo);display:grid;place-items:center;font-size:11px;font-weight:700;}
  .vis-card{background:#fff;border:1px solid var(--line);box-shadow:0 18px 44px rgba(22,23,29,0.10);padding:20px;position:relative;}
  .vis-tag{position:absolute;top:-11px;left:16px;background:var(--ink);color:#fff;font-family:var(--mono);font-size:9.5px;letter-spacing:0.12em;padding:4px 10px;}

  /* form builder vignette */
  .field{display:flex;align-items:center;gap:10px;border:1px solid var(--line);padding:11px 13px;background:#fff;margin-bottom:8px;}
  .grip{color:#cfc8ba;font-size:13px;letter-spacing:2px;flex:none;}
  .field .fname{font-size:13.5px;font-weight:600;}
  .field .ftype{margin-left:auto;font-family:var(--mono);font-size:9.5px;letter-spacing:0.08em;color:var(--ink3);text-align:right;}
  .field.cond{margin-left:26px;border-left:3px solid var(--indigo);}
  .badge{font-family:var(--mono);font-size:9px;letter-spacing:0.06em;background:var(--indigo-tint);color:var(--indigo);padding:2.5px 7px;font-weight:600;margin-left:auto;}
  .counter{font-family:var(--mono);font-size:9.5px;color:var(--green);font-weight:600;}

  /* scoring vignette */
  .sub-title{font-size:15px;font-weight:700;letter-spacing:-0.01em;margin-bottom:3px;}
  .blind{display:inline-block;font-family:var(--mono);font-size:9px;letter-spacing:0.1em;background:#f1eee7;color:var(--ink3);padding:3px 8px;font-weight:600;margin-bottom:14px;}
  .crit{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--line);font-size:13px;}
  .crit .cname{width:110px;font-weight:600;}
  .keys{display:flex;gap:5px;}
  .key{width:26px;height:26px;border:1px solid #d8d2c6;background:#fbfaf7;display:grid;place-items:center;font-family:var(--mono);font-size:11.5px;color:var(--ink2);box-shadow:0 1.5px 0 #d8d2c6;}
  .key.on{background:var(--indigo);border-color:var(--indigo);color:#fff;box-shadow:0 1.5px 0 var(--indigo-dk);}
  .score-foot{display:flex;align-items:center;gap:10px;margin-top:14px;font-family:var(--mono);font-size:10px;color:var(--ink3);}
  .score-foot .enter{border:1px solid #d8d2c6;padding:3px 9px;background:#fbfaf7;box-shadow:0 1.5px 0 #d8d2c6;color:var(--ink2);white-space:nowrap;}
  .prog{flex:1;height:5px;background:#efece5;position:relative;}
  .prog i{position:absolute;top:0;bottom:0;left:0;width:62%;background:var(--green);}

  /* portal vignette */
  .portal-head{display:flex;align-items:center;gap:12px;margin-bottom:16px;}
  .avatar{width:38px;height:38px;border-radius:50%;background:var(--indigo);color:#fff;display:grid;place-items:center;font-family:var(--mono);font-size:13px;font-weight:600;}
  .portal-head .n{font-size:15px;font-weight:700;}
  .portal-head .e{font-family:var(--mono);font-size:10px;color:var(--ink3);}
  .task{display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--line);margin-bottom:7px;font-size:13.5px;background:#fff;}
  .cb{flex:none;width:17px;height:17px;border:1.5px solid #cfc8ba;display:grid;place-items:center;font-size:11px;}
  .cb.done{background:var(--green);border-color:var(--green);color:#fff;}
  .task.dim{color:var(--ink2);}
  .task .due{margin-left:auto;font-family:var(--mono);font-size:9.5px;color:var(--amber-dk);background:#fdf6dd;padding:2.5px 7px;font-weight:600;white-space:nowrap;}
  .task .done-tag{margin-left:auto;font-family:var(--mono);font-size:9.5px;color:var(--green);font-weight:600;}

  /* agenda vignette */
  .ag-grid{display:grid;grid-template-columns:44px 1fr 1fr;gap:5px;font-size:10px;}
  .ag-grid .hdr{font-family:var(--mono);font-size:9px;letter-spacing:0.1em;color:var(--ink3);padding-bottom:2px;}
  .ag-grid .time{font-family:var(--mono);font-size:9px;color:var(--ink3);display:flex;align-items:flex-start;padding-top:6px;}
  .ses{padding:9px 10px;font-weight:600;line-height:1.3;color:#fff;background:var(--indigo);}
  .ses.s2{background:#7c6bd8;} .ses.s3{background:#3f8f6e;} .ses.empty{background:#f4f1ea;border:1px dashed #d8d2c6;}
  .ses.conflict{background:#fff;border:1.5px solid var(--amber-dk);color:var(--amber-dk);}
  .conflict-note{display:flex;gap:8px;align-items:center;margin-top:12px;font-size:11.5px;color:var(--amber-dk);background:#fdf6dd;padding:8px 11px;font-weight:600;}
  .publish-row{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap;}
  .publish-row .pub{background:var(--ink);color:#fff;font-size:12px;font-weight:600;padding:8px 14px;}
  .publish-row .rev-tag{font-family:var(--mono);font-size:9.5px;color:var(--ink3);}

  /* ------------------------------------------------------- dark band */
  .dark{background:#16171d;color:#fff;}
  .dark-inner{padding-top:88px;padding-bottom:88px;}
  .dark .kicker{color:#8f9bff;}
  .dark h2{margin:14px 0 16px;font-size:38px;letter-spacing:-0.025em;line-height:1.1;}
  .dark .lede{margin:0 0 44px;font-size:16px;line-height:1.65;color:#b9bcc6;max-width:62ch;}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;}
  .stat{border-top:1px solid #2c2d36;padding-top:20px;}
  .stat .big{font-size:40px;font-weight:700;letter-spacing:-0.03em;line-height:1;}
  .stat .big em{font-style:normal;color:#8f9bff;}
  .stat .cap{font-family:var(--mono);font-size:10px;letter-spacing:0.14em;color:#83858f;margin:10px 0 8px;}
  .stat p{margin:0;font-size:13.5px;line-height:1.6;color:#c9cbd4;}

  /* ---------------------------------------------------------- agents */
  .agents{padding:96px 0;background:var(--paper);}
  .agents .lede{margin:0 0 24px;}
  .agents .more{display:inline-flex;gap:18px;margin-top:26px;font-size:14.5px;font-weight:600;flex-wrap:wrap;}
  .term{background:#16171d;box-shadow:0 18px 44px rgba(22,23,29,0.18);}
  .term-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #2c2d36;}
  .term-bar .dot{background:#3a3b45;}
  .term-bar .tt{font-family:var(--mono);font-size:9.5px;letter-spacing:0.12em;color:#83858f;margin-left:6px;}
  .term-body{padding:16px 18px;font-family:var(--mono);font-size:11.5px;line-height:1.8;color:#d7d8de;overflow-x:auto;white-space:pre;}
  .term-body .p{color:#8f9bff;}
  .term-body .ok{color:#5fd08a;}
  .term-body .dim{color:#83858f;}
  .term-body .you{color:var(--amber);}

  /* ------------------------------------------------------ opensource */
  .oss-strip{border-bottom:1px solid var(--line);background:#fff;}
  .oss-strip-inner{display:flex;align-items:baseline;gap:18px;padding-top:22px;padding-bottom:22px;font-size:14px;color:var(--ink2);flex-wrap:wrap;}
  .oss-strip-inner a{font-weight:600;white-space:nowrap;}

  /* ----------------------------------------------------- closing CTA */
  .closing{background:var(--indigo);color:#fff;position:relative;overflow:hidden;}
  .closing::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 1px 1px, rgba(255,255,255,0.14) 1px, transparent 0);background-size:26px 26px;}
  .closing-inner{position:relative;padding-top:92px;padding-bottom:92px;text-align:center;}
  .closing .k2{font-family:var(--mono);font-size:11px;letter-spacing:0.16em;color:#c3cbff;font-weight:600;}
  .closing h2{margin:16px auto 16px;font-size:clamp(30px,4vw,46px);letter-spacing:-0.03em;line-height:1.08;max-width:22ch;}
  .closing p{margin:0 auto 34px;font-size:16px;line-height:1.6;color:#dde1ff;max-width:52ch;}
  .closing .btn-white{background:#fff;color:var(--ink);box-shadow:0 2px 0 rgba(0,0,0,0.25);}
  .closing .note{margin-top:16px;font-family:var(--mono);font-size:11px;color:#b9c2ff;}
  .closing .note a{color:#fff;text-decoration:underline;}

  /* ---------------------------------------------------------- footer */
  .footer{padding:26px 0;}
  .footer-inner{display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-family:var(--mono);font-size:10.5px;letter-spacing:0.12em;color:var(--ink3);}
  .footer-inner .right{margin-left:auto;display:flex;gap:18px;}
  .footer-inner a{color:var(--ink3);}

  @media(max-width:1000px){
    /* keep the floating cards inside the viewport once side margins shrink */
    .float-agenda{right:-8px;} .float-mail{left:-8px;}
  }
  @media(max-width:900px){
    .f-grid{grid-template-columns:minmax(0,1fr);gap:40px;}
    .f-grid.rev .f-copy{order:1;} .f-grid.rev .f-vis{order:2;}
    .stats{grid-template-columns:1fr;gap:26px;}
    .qrow{grid-template-columns:1fr 92px;} .qrow .barcell,.qrow .score{display:none;}
  }
  @media(max-width:720px){
    .wrap{padding-left:20px;padding-right:20px;}
    .nav-links{display:none;}
    /* the whole bar has to survive 320px: logo + Sign in + CTA */
    .nav-inner{gap:8px;}
    .nav-cta{gap:6px;}
    .nav-cta .signin{padding:11px 4px;white-space:nowrap;}
    .nav-cta .btn{padding:11px 10px;white-space:nowrap;}
    .cta-full{display:none;}
    .cta-mini{display:inline;}
    .hero-inner{padding-top:56px;}
    .hero h1{font-size:clamp(32px,9vw,44px);}
    .hero p{font-size:16px;}
    .feature,.agents{padding:56px 0;}
    .feature h2,.agents h2{font-size:26px;}
    .dark-inner{padding-top:56px;padding-bottom:56px;}
    .dark h2{font-size:28px;}
    .stat .big{font-size:32px;}
    .closing-inner{padding-top:60px;padding-bottom:60px;}
    .pipeline-inner{padding-top:16px;padding-bottom:16px;}
    .pstep span{font-size:9.5px;letter-spacing:0.1em;padding:5px 2px;}
    .pstep .arr{padding:0 7px;}
    /* footer links are 14px tall by default — too small to tap reliably */
    .footer-inner .right{gap:4px;}
    .footer-inner a{padding:12px 7px;}
    /* scoring vignette: the fixed criterion column plus five keys is wider
       than a 320px card, so let the label take whatever is left */
    .crit .cname{width:auto;flex:1 1 auto;min-width:0;}
    .keys{flex:none;}
    .term-body{font-size:11px;}
  }
  @media(max-width:640px){
    /* collage: floating cards become stacked cards instead of overlapping */
    .collage{margin-top:44px;}
    .float{position:static;width:auto;margin-top:14px;box-shadow:0 10px 28px rgba(22,23,29,0.12);}
    .browser{box-shadow:0 14px 36px rgba(22,23,29,0.12);}
    .hero-ctas .btn, .hero-ctas form{flex:1 1 100%;text-align:center;}
    .hero-ctas form .btn{width:100%;}
  }
`;

/* ------------------------------------------------------------ components */

function SandboxForm(props: { variant: 'nav' | 'primary' | 'amber' }) {
  const cls = props.variant === 'amber' ? 'btn btn-amber' : 'btn btn-primary';
  // The nav bar has ~280px to hold logo + Sign in + this button at 320px wide,
  // so the nav copy shortens below the breakpoint. The page CTAs keep the
  // full label — they have a whole row to themselves.
  return (
    <form method="post" action="/sandbox" style="margin:0;display:inline-block;">
      <button type="submit" class={cls}>
        {props.variant === 'nav' ? (
          <>
            <span class="cta-full">Try the sandbox →</span>
            <span class="cta-mini">Sandbox →</span>
          </>
        ) : (
          'Try the sandbox →'
        )}
      </button>
    </form>
  );
}

type Feature = {
  num: string;
  kicker: string;
  title: string;
  lede: string;
  ticks: { b: string; rest: string }[];
  visTag: string;
  vis: unknown;
  reversed?: boolean;
};

const FormBuilderVis = (
  <div class="vis-card">
    <span class="vis-tag">FORM BUILDER</span>
    <div class="field">
      <span class="grip">⋮⋮</span>
      <span class="fname">Talk title</span>
      <span class="ftype">SHORT TEXT · REQUIRED</span>
    </div>
    <div class="field">
      <span class="grip">⋮⋮</span>
      <span class="fname">Abstract</span>
      <span class="ftype">
        <span class="counter">142 / 150 words</span> · LONG TEXT
      </span>
    </div>
    <div class="field">
      <span class="grip">⋮⋮</span>
      <span class="fname">Format</span>
      <span class="ftype">SELECT · TALK / WORKSHOP / LIGHTNING</span>
    </div>
    <div class="field cond">
      <span class="grip">⋮⋮</span>
      <span class="fname">Room setup needs</span>
      <span class="badge">IF FORMAT = WORKSHOP</span>
    </div>
    <div class="field">
      <span class="grip">⋮⋮</span>
      <span class="fname">Slides (draft)</span>
      <span class="ftype">FILE · PDF · 20 MB</span>
    </div>
  </div>
);

function Keys(props: { on: number }) {
  return (
    <span class="keys">
      {[1, 2, 3, 4, 5].map((n) => (
        <span class={n === props.on ? 'key on' : 'key'}>{n}</span>
      ))}
    </span>
  );
}

const ScoringVis = (
  <div class="vis-card">
    <span class="vis-tag">KEYBOARD SCORING</span>
    <div class="sub-title">Shipping WASM at the edge</div>
    <span class="blind">🕶 BLIND REVIEW — SPEAKER HIDDEN</span>
    <div class="crit">
      <span class="cname">Relevance</span>
      <Keys on={5} />
    </div>
    <div class="crit">
      <span class="cname">Depth</span>
      <Keys on={4} />
    </div>
    <div class="crit">
      <span class="cname">Clarity</span>
      <Keys on={5} />
    </div>
    <div class="score-foot">
      <span class="enter">↵ ENTER</span>
      <span>SUBMIT &amp; NEXT</span>
      <span class="prog">
        <i></i>
      </span>
      <span>74 / 120</span>
    </div>
  </div>
);

const PortalVis = (
  <div class="vis-card">
    <span class="vis-tag">SPEAKER PORTAL</span>
    <div class="portal-head">
      <div class="avatar">PN</div>
      <div>
        <div class="n">Priya Natarajan</div>
        <div class="e">SIGNED IN VIA MAGIC LINK · NO PASSWORD</div>
      </div>
    </div>
    <div class="task dim">
      <span class="cb done">✓</span>Confirm participation<span class="done-tag">DONE</span>
    </div>
    <div class="task dim">
      <span class="cb done">✓</span>Complete your speaker profile<span class="done-tag">DONE</span>
    </div>
    <div class="task">
      <span class="cb"></span>Upload your slides (PDF)<span class="due">DUE SEP 12</span>
    </div>
    <div class="task">
      <span class="cb"></span>Confirm A/V requirements<span class="due">DUE SEP 19</span>
    </div>
  </div>
);

const AgendaVis = (
  <div class="vis-card">
    <span class="vis-tag">AGENDA BUILDER</span>
    <div class="ag-grid">
      <span></span>
      <span class="hdr">MAIN STAGE</span>
      <span class="hdr">STUDIO B</span>
      <span class="time">09:00</span>
      <span class="ses">Opening keynote</span>
      <span class="ses empty"></span>
      <span class="time">10:00</span>
      <span class="ses s2">WASM at the edge</span>
      <span class="ses s3">Postgres workshop</span>
      <span class="time">11:00</span>
      <span class="ses s3">Design systems that survive v2</span>
      <span class="ses conflict">⚠ Priya is on Main Stage</span>
    </div>
    <div class="conflict-note">⚠ 1 conflict — speaker double-booked at 11:00</div>
    <div class="publish-row">
      <span class="pub">Publish revision 14 →</span>
      <span class="rev-tag">LIVE EVERYWHERE, INSTANTLY</span>
    </div>
  </div>
);

const FEATURES: Feature[] = [
  {
    num: '01',
    kicker: 'COLLECT',
    title: 'A call for speakers people actually finish',
    lede: 'Every abandoned draft is a talk you never got to consider. Unsession’s forms are easy to start, hard to lose, and painless on a phone.',
    ticks: [
      { b: 'Drafts survive anything', rest: '. Autosaved from the first keystroke, resumable on any device by link.' },
      { b: 'Ask only what’s relevant', rest: '. A workshop pitch and a lightning talk each see their own questions.' },
      {
        b: 'Your brand, your questions',
        rest: '. Co-speakers, files, word limits, live and taking proposals in fifteen minutes.',
      },
    ],
    visTag: 'FORM BUILDER',
    vis: FormBuilderVis,
  },
  {
    num: '02',
    kicker: 'DECIDE',
    title: 'Fair decisions, made in an evening',
    lede: 'Give every proposal the same fair read, see the results ranked, and send accept, waitlist, or decline decisions knowing exactly what each speaker will receive.',
    ticks: [
      {
        b: 'Talks win on merit',
        rest: '. Blind review hides names and bios in one toggle, so the work gets judged, not the byline.',
      },
      {
        b: 'Your committee flies through the queue',
        rest: '. Score with the number keys; a hundred reviews is an evening, not a weekend.',
      },
      { b: 'No decision leaves unchecked', rest: '. Every email is previewed and confirmed before it goes out.' },
    ],
    visTag: 'KEYBOARD SCORING',
    vis: ScoringVis,
    reversed: true,
  },
  {
    num: '03',
    kicker: 'ONBOARD',
    title: 'Speakers arrive ready — without the chasing',
    lede: 'The weeks between “accepted” and stage day are where events go sideways. Give each speaker one link and a clear checklist, and get out of the reminder-email business.',
    ticks: [
      { b: 'One link, zero passwords', rest: '. Speakers see exactly what’s needed and when, and do it themselves.' },
      {
        b: 'Slides, headshots, A/V needs',
        rest: '. Collected with due dates, landing in your files instead of your inbox.',
      },
      { b: 'Schedule changes that stick', rest: '. Calendar invites update themselves when you move a session.' },
    ],
    visTag: 'SPEAKER PORTAL',
    vis: PortalVis,
  },
  {
    num: '04',
    kicker: 'PUBLISH',
    title: 'An agenda you can stand behind on stage day',
    lede: 'Build the schedule by dragging sessions into place — and catch double-booked rooms and speakers before your attendees do. Publish once, and it’s current everywhere.',
    ticks: [
      { b: 'Conflicts surface instantly', rest: '. No more cross-checking rooms and speakers by hand.' },
      {
        b: 'Looks like your event',
        rest: '. One brand color becomes a polished, accessible public agenda and speaker directory.',
      },
      { b: 'Everywhere at once', rest: '. Your site, embeds, speaker pages, and your team’s tools all stay in sync.' },
    ],
    visTag: 'AGENDA BUILDER',
    vis: AgendaVis,
    reversed: true,
  },
];

const QUEUE_ROWS = [
  { t: 'Shipping WASM at the edge', s: 'Priya Natarajan', w: '88%', score: '4.4 / 5', pill: 'acc', status: 'ACCEPTED' },
  { t: 'Postgres for people in a hurry', s: 'Marcus Chen', w: '76%', score: '3.8 / 5', pill: 'rev', status: 'IN REVIEW' },
  { t: 'Design systems that survive v2', s: 'Amara Okafor', w: '82%', score: '4.1 / 5', pill: 'wait', status: 'WAITLIST' },
  { t: 'Live-coding a compiler, badly', s: 'Jonas Weber', w: '90%', score: '4.5 / 5', pill: 'acc', status: 'ACCEPTED' },
];

const PIPELINE = ['COLLECT', 'EVALUATE', 'DECIDE', 'ONBOARD', 'SCHEDULE', 'PUBLISH'];

/**
 * The MCP vignette. Rendered one `<div>` per line inside `white-space:pre`, so
 * leading spaces survive without the source indentation leaking in.
 */
const TERMINAL: [string, string][] = [
  ['p', '$ claude mcp add --transport http unsession \\'],
  ['p', '    https://unsession.dev/api/mcp'],
  ['', ' '],
  ['ok', '✓ Authenticated · unsession · 84 tools'],
  ['', ' '],
  ['you', '> which accepted speakers still owe us slides?'],
  ['', ' '],
  ['dim', '  ⚙ list_sessions → list_tasks → list_speakers'],
  ['', ' '],
  ['', '  3 of 41 are outstanding: Marcus Chen, Amara'],
  ['', '  Okafor, Jonas Weber. Want me to assign the'],
  ['', '  slides task and send the reminder digest?'],
];

const STATS = [
  {
    big: '1',
    rest: ' place',
    cap: 'THE WHOLE PIPELINE',
    p: 'Proposals, reviews, decisions, speaker tasks, and the agenda live together — not spread across a form tool, a spreadsheet, and someone’s inbox.',
  },
  {
    big: '0',
    rest: ' dropped balls',
    cap: 'EVERY MESSAGE ON THE RECORD',
    p: 'Every decision, email, task, and schedule change is logged per submission — so “did we tell them?” is always one click away, not an inbox dig.',
  },
  {
    big: '0',
    rest: ' surprises',
    cap: 'CONFLICTS CAUGHT EARLY',
    p: 'Double-booked rooms and speakers in two places flag themselves while you’re still dragging sessions around — not during the opening keynote.',
  },
];

/* ------------------------------------------------------------------- page */

app.get('/', (c) => {
  const origin = (c.env.APP_ORIGIN || new URL(c.req.url).origin).replace(/\/$/, '');
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <SocialMeta
          title="Unsession — from open call to opening keynote"
          description="Unsession runs the whole speaker side of your event. Proposals in, fair reviews, confident decisions, speakers who show up ready, and an agenda you can publish and trust. Open source, free to try in the sandbox."
          url={`${origin}/`}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={GOOGLE_FONTS} rel="stylesheet" />
        <style>{raw(CSS)}</style>
      </head>
      <body>
        {/* ---------------------------------------------------------- nav */}
        <div class="nav">
          <div class="wrap nav-inner">
            <a href="/" aria-label="Unsession home" class="nav-brand" style="color:var(--ink);text-decoration:none;">
              <ProductLogo height={22} style="width:100%;height:auto;" />
            </a>
            <div class="nav-links">
              <a href="#how">How it works</a>
              <a href="/docs">Docs</a>
              <a href={GITHUB}>GitHub</a>
            </div>
            <div class="nav-cta">
              <a class="signin" href="/signin">
                Sign in
              </a>
              <SandboxForm variant="nav" />
            </div>
          </div>
        </div>

        {/* --------------------------------------------------------- hero */}
        <div class="hero">
          <div class="wrap hero-inner">
            <div class="kicker">FOR CONFERENCE ORGANIZERS &amp; PROGRAM TEAMS</div>
            <h1>
              Open source <em>session management</em>
            </h1>
            <p>
              Unsession runs the whole speaker side of your event. Proposals in, fair reviews, confident
              decisions, speakers who show up ready, and an agenda you can publish and trust.
            </p>
            <div class="hero-ctas">
              <SandboxForm variant="primary" />
              <a class="btn btn-ghost" href="/signup">
                Create a free account
              </a>
            </div>

            <div class="collage">
              <div class="browser">
                <div class="browser-bar">
                  <span class="dot"></span>
                  <span class="dot"></span>
                  <span class="dot"></span>
                  <span class="urlbar">unsession.dev/app/submissions</span>
                </div>
                <div class="queue">
                  <div class="queue-head">
                    <b>Submissions</b>
                    <span>128 IN REVIEW · DEVCONF 2027</span>
                  </div>
                  {QUEUE_ROWS.map((r) => (
                    <div class="qrow">
                      <span>
                        <span class="t">{r.t}</span>
                        <br />
                        <span class="s">{r.s}</span>
                      </span>
                      <span class="barcell">
                        <span class="bar">
                          <i style={`width:${r.w}`}></i>
                        </span>
                      </span>
                      <span class="score">{r.score}</span>
                      <span class={`pill ${r.pill}`}>{r.status}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div class="float float-agenda">
                <div class="float-label">AGENDA · DAY 2</div>
                <div class="mini-grid">
                  <span></span>
                  <span class="float-label" style="margin:0;">
                    MAIN
                  </span>
                  <span class="float-label" style="margin:0;">
                    STUDIO
                  </span>
                  <span class="time">09:00</span>
                  <span class="blk">Opening keynote</span>
                  <span class="blk warn">⚠ conflict</span>
                  <span class="time">10:00</span>
                  <span class="blk b2">WASM at the edge</span>
                  <span class="blk b3">Postgres workshop</span>
                  <span class="time">11:00</span>
                  <span class="blk b3">Design systems</span>
                  <span class="blk b2">Compilers, badly</span>
                </div>
              </div>

              <div class="float float-mail">
                <div class="float-label">DECISION EMAIL · PREVIEW</div>
                <div class="mail-line">
                  To: <b>priya@example.dev</b>
                </div>
                <div class="mail-line">
                  Subject: <b>Your talk is accepted 🎉</b>
                </div>
                <div class="mail-btns">
                  <span class="send">Send 42 emails</span>
                  <span class="prev">Preview first</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------- pipeline */}
        <div class="pipeline">
          <div class="wrap pipeline-inner">
            {PIPELINE.map((step, i) => (
              <div class={i === 0 ? 'pstep active' : 'pstep'}>
                <span>{step}</span>
                {i < PIPELINE.length - 1 ? <span class="arr">→</span> : null}
              </div>
            ))}
          </div>
        </div>

        {/* ----------------------------------------------------- features */}
        <div id="how">
          {FEATURES.map((f) => (
            <div class="feature">
              <div class={f.reversed ? 'wrap f-grid rev' : 'wrap f-grid'}>
                <div class="f-copy">
                  <div class="kicker">
                    {f.num} · {f.kicker}
                  </div>
                  <h2>{f.title}</h2>
                  <p class="lede">{f.lede}</p>
                  <ul class="ticks">
                    {f.ticks.map((t) => (
                      <li>
                        <span class="tick">✓</span>
                        <span>
                          <b>{t.b}</b>
                          {t.rest}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div class="f-vis">{f.vis}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ---------------------------------------------------- dark band */}
        <div class="dark">
          <div class="wrap dark-inner">
            <div class="kicker">THE QUIET PART</div>
            <h2>Nothing falls through the cracks.</h2>
            <p class="lede">
              The real cost of running a call for speakers isn’t the busywork — it’s the dropped balls. The
              speaker nobody emailed. The room booked twice. The reviewer who quietly stopped. Unsession is
              built so those don’t happen.
            </p>
            <div class="stats">
              {STATS.map((s) => (
                <div class="stat">
                  <div class="big">
                    <em>{s.big}</em>
                    {s.rest}
                  </div>
                  <div class="cap">{s.cap}</div>
                  <p>{s.p}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------ agents */}
        <div class="agents" id="agents">
          <div class="wrap f-grid">
            <div class="f-copy">
              <div class="kicker">FOR AGENTS · MCP + API</div>
              <h2>Your AI agent can work the CFP with you</h2>
              <p class="lede">
                Unsession ships a Model Context Protocol server, so Claude Code, Claude, Cursor — anything that
                speaks MCP — can read your submission queue, pull evaluation scores, accept a talk, add a sponsor
                session, or move something on the agenda. Same engines, same permissions, same activity log as the
                admin UI.
              </p>
              <ul class="ticks">
                <li>
                  <span class="tick">✓</span>
                  <span>
                    <b>One command to connect</b> — point your agent at{' '}
                    <span style="font-family:var(--mono);font-size:13px;">unsession.dev/api/mcp</span> and sign in
                    with OAuth, or mint a token in the admin. Nothing to install or host.
                  </span>
                </li>
                <li>
                  <span class="tick">✓</span>
                  <span>
                    <b>Read-only or read-write</b> — an agent you trust to answer questions isn’t the one you trust
                    to send decisions. Read-only tokens can’t even see the write tools.
                  </span>
                </li>
                <li>
                  <span class="tick">✓</span>
                  <span>
                    <b>Every write is on the record</b> — the activity log names the token, so “who moved this
                    session?” answers the same for an agent as for a person.
                  </span>
                </li>
              </ul>
              <div class="more">
                <a href="/docs/mcp">Read the MCP docs →</a>
                <a href="/docs/mcp#rest">Or use the REST API →</a>
              </div>
            </div>
            <div class="f-vis">
              <div class="term">
                <div class="term-bar">
                  <span class="dot"></span>
                  <span class="dot"></span>
                  <span class="dot"></span>
                  <span class="tt">CLAUDE CODE</span>
                </div>
                <div class="term-body">
                  {TERMINAL.map(([cls, text]) => (
                    <div class={cls}>{text}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* -------------------------------------------------- open source */}
        <div class="oss-strip" id="oss">
          <div class="wrap oss-strip-inner">
            <span class="kicker" style="color:var(--ink3);">
              OPEN SOURCE
            </span>
            <span>
              Unsession is open source under AGPL-3.0 — the hosted service runs the same code you can read,
              audit, and self-host.
            </span>
            <a href={GITHUB}>View on GitHub →</a>
          </div>
        </div>

        {/* -------------------------------------------------- closing CTA */}
        <div class="closing">
          <div class="wrap closing-inner">
            <div class="k2">NO SIGNUP · NO DEMO CALL · NO CREDIT CARD</div>
            <h2>See a real event, mid-lifecycle, in thirty seconds</h2>
            <p>
              The sandbox is a live event with submissions in review, an agenda half-built, and a speaker
              mid-onboarding. Pick a seat: organizer, speaker, or evaluator.
            </p>
            <div class="hero-ctas">
              <SandboxForm variant="amber" />
              <a class="btn btn-outline-light" href="/signup">
                Create a free account
              </a>
            </div>
            <div class="note">
              Already have an event to run? <a href="/signin">Sign in</a>.
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------- footer */}
        <div class="footer">
          <div class="wrap footer-inner">
            <ProductLogo height={16} />
            <span class="right">
              <a href="/events">EVENTS</a>
              <a href="/docs">DOCS</a>
              <a href={GITHUB}>SOURCE</a>
              <span>AGPL-3.0</span>
            </span>
          </div>
        </div>
      </body>
    </html>
  );
});

/* -------------------------------------------------------- event directory */

const EVENTS_CSS = `
  :root{--ink:#16171d;--ink2:#555a63;--ink3:#8b857a;--paper:#faf8f5;--line:#ece7de;--indigo:#4c5fd5;--mono:'IBM Plex Mono',monospace;}
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:var(--paper);color:var(--ink);font-family:'Space Grotesk',system-ui,sans-serif;}
  a{color:var(--indigo);text-decoration:none;} a:hover{text-decoration:underline;}
  .wrap{max-width:760px;margin:0 auto;padding:0 24px;}
  .nav{border-bottom:1px solid var(--line);background:#fff;}
  .nav-inner{display:flex;align-items:center;gap:12px;padding-top:14px;padding-bottom:14px;}
  .nav-brand{display:block;flex:0 1 143px;min-width:0;}
  .nav-links{margin-left:36px;display:flex;gap:24px;font-size:14px;}
  .nav-links a{color:var(--ink2);}
  .nav-links a:hover{text-decoration:none;color:var(--ink);}
  .nav-cta{margin-left:auto;flex:none;display:flex;gap:10px;align-items:center;}
  .nav-cta .signin{font-size:14px;font-weight:600;color:var(--ink);padding:9px 14px;}
  .nav-cta .btn{display:inline-block;padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border:none;font-family:inherit;line-height:normal;}
  .nav-cta .btn-primary{background:var(--indigo);color:#fff;box-shadow:0 2px 0 #3a4ab8;}
  .cta-mini{display:none;}
  @media(max-width:720px){
    .wrap{padding-left:20px;padding-right:20px;}
    .nav-links{display:none;}
    .nav-inner{gap:8px;}
    .nav-cta{gap:6px;}
    .nav-cta .signin{padding:11px 4px;white-space:nowrap;}
    .nav-cta .btn{padding:11px 10px;white-space:nowrap;}
    .cta-full{display:none;}
    .cta-mini{display:inline;}
  }
  .card{display:block;background:#fff;border:1px solid var(--line);padding:18px 20px;color:var(--ink);}
  .card:hover{border-color:var(--indigo);text-decoration:none;}
  .card + .card{margin-top:10px;}
`;

/**
 * Public directory of published events — the way in from the bare origin to an
 * event's attendee pages without knowing its slug.
 */
app.get('/events', async (c) => {
  const rows = await all<Event>(
    c.env.DB,
    `SELECT e.* FROM events e JOIN orgs o ON o.id = e.org_id
      WHERE e.published = 1 AND o.is_sandbox = 0
      ORDER BY e.start_date DESC LIMIT 100`
  );
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter((e) => (e.end_date || e.start_date) >= today).reverse();
  const past = rows.filter((e) => (e.end_date || e.start_date) < today);

  const card = (e: Event) => (
    <a class="card" href={`/${e.slug}/agenda`}>
      <div style="font-size:16.5px;font-weight:700;letter-spacing:-0.01em;">{e.name}</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:5px;">
        {[fmtDateRange(e.start_date, e.end_date), e.venue || null, e.mode === 'online' ? 'online' : e.mode === 'hybrid' ? 'hybrid' : null]
          .filter(Boolean)
          .join(' · ')}
      </div>
      <div style="display:flex;gap:14px;font-size:12.5px;color:var(--indigo);margin-top:9px;">
        <span>Agenda</span>
        <span>Sessions</span>
        <span>Speakers</span>
      </div>
    </a>
  );

  const origin = (c.env.APP_ORIGIN || new URL(c.req.url).origin).replace(/\/$/, '');
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <SocialMeta
          title="Events on Unsession"
          description="Published events running on Unsession — browse each event's agenda, sessions, and speakers."
          url={`${origin}/events`}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={GOOGLE_FONTS} rel="stylesheet" />
        <style>{raw(EVENTS_CSS)}</style>
      </head>
      <body>
        <div class="nav">
          <div class="wrap nav-inner">
            <a href="/" aria-label="Unsession home" class="nav-brand" style="color:var(--ink);text-decoration:none;">
              <ProductLogo height={22} style="width:100%;height:auto;" />
            </a>
            <div class="nav-links">
              <a href="/#how">How it works</a>
              <a href="/docs">Docs</a>
              <a href={GITHUB}>GitHub</a>
            </div>
            <div class="nav-cta">
              <a class="signin" href="/signin">
                Sign in
              </a>
              <SandboxForm variant="nav" />
            </div>
          </div>
        </div>
        <div class="wrap" style="padding-top:44px;padding-bottom:80px;">
          <div style="font-family:var(--mono);font-size:11px;letter-spacing:0.16em;color:var(--indigo);font-weight:600;">
            EVENT DIRECTORY
          </div>
          <h1 style="margin:12px 0 6px;font-size:30px;letter-spacing:-0.025em;">Events on Unsession</h1>
          <p style="margin:0 0 28px;font-size:14.5px;line-height:1.6;color:var(--ink2);">
            Every published event site is open to everyone, no account needed.
          </p>
          {upcoming.length ? (
            <div style="margin-bottom:28px;">
              <div style="font-family:var(--mono);font-size:10.5px;letter-spacing:0.14em;color:var(--ink3);margin-bottom:10px;">
                UPCOMING
              </div>
              {upcoming.map(card)}
            </div>
          ) : null}
          {past.length ? (
            <div>
              <div style="font-family:var(--mono);font-size:10.5px;letter-spacing:0.14em;color:var(--ink3);margin-bottom:10px;">
                PAST
              </div>
              {past.map(card)}
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div style="background:#fff;border:1px solid var(--line);padding:36px 24px;text-align:center;">
              <div style="font-size:16px;font-weight:700;">No published events yet</div>
              <div style="font-size:13px;color:var(--ink2);margin-top:6px;line-height:1.6;">
                When an organizer publishes an event's agenda, its public site shows up here.
                <br />
                Running an event? <a href="/signin">Sign in</a> or try the <a href="/">sandbox</a>.
              </div>
            </div>
          ) : null}
        </div>
      </body>
    </html>
  );
});

/**
 * Hands the visitor the role picker for a pre-seeded sandbox from the pool
 * (instant), seeding inline only when the pool is empty. Either way the pool
 * refills after the response is sent.
 */
app.post('/sandbox', async (c) => {
  const pooled = await claimPooledSandbox(c.env);
  c.executionCtx.waitUntil(
    topUpSandboxPool(c.env).catch((err) => console.error('[sandbox-pool] top-up failed', err))
  );
  if (pooled) return c.redirect(`/sandbox/${pooled}`);
  const { orgId } = await seedSandbox(c.env);
  return c.redirect(`/sandbox/${orgId}`);
});

export default app;
