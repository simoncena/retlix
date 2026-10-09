import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { isRestoring as _isPageRestoring } from './pageState.js';

var TvContext = createContext({ isTV: false });
var useTV = function() { return useContext(TvContext); };
export { TvContext, useTV };

var TV_UA = /Tizen|Web0S|SMART-TV|SmartTV|NetCast|BRAVIA|PhilipsTV|HbbTV|Viera|Roku|CrKey/i;

export function detectTV() {
  if (typeof navigator === 'undefined') return false;
  if (TV_UA.test(navigator.userAgent)) return true;
  if (window.__RETLIX_TV__) return true;
  try { return localStorage.getItem('retlix_tv') === '1'; } catch(e) { return false; }
}

export function enableTV(on) {
  try { if (on) localStorage.setItem('retlix_tv', '1'); else localStorage.removeItem('retlix_tv'); } catch(e) {}
}

// Map keyCode to direction — Samsung Tizen sends keyCode, not e.key
var CODE_TO_DIR = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
var CODE_TO_KEY = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };
// Enter = 13, Return = 10009 (Samsung Back), OK button = 13
var ENTER_CODES = [13];
var BACK_CODES = [10009, 27, 461]; // XF86Back, Escape, LG Back

export function useSpatialNav(active) {
  useEffect(function() {
    if (!active) return;

    function getFocusables() {
      // If a modal is open, constrain focus to it
      var scope = document.querySelector('.modal-overlay') || document;
      var els = scope.querySelectorAll('[data-focusable]');
      var result = [];
      for (var i = 0; i < els.length; i++) {
        if (els[i].offsetParent !== null && !els[i].disabled) result.push(els[i]);
      }
      return result;
    }

    function getRect(el) { return el.getBoundingClientRect(); }

    function best(from, candidates, dir) {
      var r = getRect(from);
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var pick = null;
      var score = Infinity;

      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el === from) continue;
        var t = getRect(el);
        var tx = t.left + t.width / 2;
        var ty = t.top + t.height / 2;
        var primary, cross;

        if (dir === 'left')  { primary = cx - tx; cross = Math.abs(cy - ty); }
        else if (dir === 'right') { primary = tx - cx; cross = Math.abs(cy - ty); }
        else if (dir === 'up')    { primary = cy - ty; cross = Math.abs(cx - tx); }
        else                      { primary = ty - cy; cross = Math.abs(cx - tx); }

        if (primary < 5) continue;
        var s = primary + cross * 2;
        if (s < score) { score = s; pick = el; }
      }
      return pick;
    }

    function onKey(e) {
      var code = e.keyCode || e.which;
      var dir = CODE_TO_DIR[code];

      // Enter/OK — skip in player (WatchTV has its own handler)
      if (ENTER_CODES.indexOf(code) >= 0) {
        if (document.querySelector('.watch')) return;
        var f = document.activeElement;
        if (f && f.hasAttribute && f.hasAttribute('data-focusable')) {
          e.preventDefault();
          f.click();
          return;
        }
      }

      // Back button — only handle blur and modal here.
      // Page-specific back (Browse categories, Player, Detail) is handled by each page's own handler.
      if (BACK_CODES.indexOf(code) >= 0) {
        // If an input or select is focused, just blur it
        var activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA') {
          e.preventDefault();
          document.activeElement.blur();
          return;
        }
        var modal = document.querySelector('.modal-overlay');
        if (modal) {
          e.preventDefault();
          e.stopPropagation();
          var closeBtn = modal.querySelector('.modal-close');
          if (closeBtn) closeBtn.click();
          return;
        }
        // Let the event propagate to page-specific handlers
        // Don't preventDefault here — let pages handle it
        return;
      }

      if (!dir) return;

      // Don't hijack arrows inside the player (WatchTV has its own layer nav)
      if (document.querySelector('.watch')) return;

      // Don't hijack arrows inside form elements
      var tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      e.preventDefault();
      var all = getFocusables();
      if (!all.length) return;

      var cur = document.activeElement;
      if (!cur || !cur.hasAttribute || !cur.hasAttribute('data-focusable')) {
        if (all[0]) all[0].focus();
        return;
      }

      // Within a focus-group, left/right stays in group; up/down escapes
      var group = cur.closest ? cur.closest('[data-focus-group]') : null;
      var pool;
      if ((dir === 'left' || dir === 'right') && group) {
        pool = [];
        for (var i = 0; i < all.length; i++) {
          if (group.contains(all[i])) pool.push(all[i]);
        }
      } else {
        pool = all;
      }

      var next = best(cur, pool, dir);
      if (next) {
        next.focus();
        // Center the focused card vertically on screen, scroll row horizontally
        try {
          var viewH = window.innerHeight || document.documentElement.clientHeight;
          var cr = next.getBoundingClientRect();
          var cardCenterY = cr.top + cr.height / 2;
          var screenCenterY = viewH / 2;
          // Always scroll so the card is at vertical center
          var scrollBy = cardCenterY - screenCenterY;
          window.scrollBy(0, scrollBy);

          // Horizontal: keep the focused card visible inside its row.
          // Cards are wrapped in .card-wrap, so parentElement is NOT the row-track.
          // Resolve the actual focus group/row and center the selected card there.
          var track = next.closest ? next.closest('.row-track') : null;
          if (!track && next.closest) track = next.closest('[data-focus-group]');
          if (track && track.scrollWidth > track.clientWidth) {
            var tr = track.getBoundingClientRect();
            var nr = next.getBoundingClientRect();
            var trackCenter = tr.left + (tr.width / 2);
            var cardCenter = nr.left + (nr.width / 2);
            var targetX = track.scrollLeft + (cardCenter - trackCenter);
            var maxX = Math.max(0, track.scrollWidth - track.clientWidth);
            track.scrollLeft = Math.max(0, Math.min(maxX, targetX));
          }
        } catch(e) {}
      }
    }

    // Auto-focus: always find the best element for the current view
    function autoFocus() {
      // Don't interfere with page state restore
      if (_isPageRestoring()) return;
      // Check if current focus is still visible on screen
      var cur = document.activeElement;
      if (cur && cur.hasAttribute && cur.hasAttribute('data-focusable') && cur.offsetParent !== null) {
        // Still valid and visible — don't steal focus
        if (!cur.closest || !cur.closest('.nav')) return;
      }
      // Find the best target for the current page
      var target = document.querySelector('.tv-detail-actions [data-focusable]')
        || document.querySelector('.tv-cat-picker .tv-cat-tutti[data-focusable]')
        || document.querySelector('.tv-cat-picker .tv-cat-item[data-focusable]')
        || document.querySelector('.tv-content-grid .card[data-focusable]')
        || document.querySelector('.tv-cat-grid .tv-cat-item[data-focusable]')
        || document.querySelector('.tv-browse-controls [data-focusable]')
        || document.getElementById('tv-home-live')
        || document.querySelector('.tv-quick-btn[data-focusable]')
        || document.querySelector('.tv-search-bar input[data-focusable]')
        || document.querySelector('.tv-settings [data-focusable]')
        || document.querySelector('.card[data-focusable]')
        || document.querySelector('[data-focusable]');
      if (target) target.focus();
    }
    setTimeout(autoFocus, 500);
    // Re-focus on any DOM change (React state updates, page navigation)
    var observer = null;
    var focusTimer = null;
    try {
      observer = new MutationObserver(function() {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(autoFocus, 200);
      });
      observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
    } catch(e) {}

    window.addEventListener('keydown', onKey, true);
    return function() {
      window.removeEventListener('keydown', onKey, true);
      if (observer) try { observer.disconnect(); } catch(e) {}
    };
  }, [active]);
}
