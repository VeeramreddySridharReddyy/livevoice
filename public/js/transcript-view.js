// Shared transcript renderer for speaker & receiver.
// - Paragraph-aware: finals append to the live paragraph; newPara starts a <p>.
// - Fast: only the live paragraph node is touched per update (no full rebuild).
// - Smart scroll: auto-follows while pinned to the bottom; scrolling up pauses
//   auto-scroll and shows a "jump to live" button.
(function () {
  window.TranscriptView = function (container, opts) {
    opts = opts || {};
    var emptyText = opts.emptyText || '';

    // Wrap the container so the jump button can float over it.
    var wrap = document.createElement('div');
    wrap.className = 'transcript-wrap';
    container.parentNode.insertBefore(wrap, container);
    wrap.appendChild(container);

    var jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'jump-live hidden';
    jump.textContent = '↓ Jump to live';
    wrap.appendChild(jump);

    var paras = [];        // finalized paragraph strings
    var interim = '';      // current interim text
    var interimHost = null; // <p> currently holding the interim span
    var interimSpan = null;
    var forceNew = false;  // manual break: next text starts a new paragraph
    var pinned = true;     // auto-scroll only while pinned to bottom

    container.addEventListener('scroll', function () {
      var nearBottom =
        container.scrollTop + container.clientHeight >= container.scrollHeight - 48;
      if (nearBottom !== pinned) {
        pinned = nearBottom;
        jump.classList.toggle('hidden', pinned);
      }
    });
    jump.addEventListener('click', function () {
      pinned = true;
      jump.classList.add('hidden');
      container.scrollTop = container.scrollHeight;
    });

    function maybeScroll() {
      if (pinned) container.scrollTop = container.scrollHeight;
    }

    function showEmpty() {
      container.className = 'transcript empty';
      container.textContent = emptyText;
      interimHost = null;
      interimSpan = null;
    }

    function ensureLiveState() {
      if (container.classList.contains('empty')) {
        container.className = 'transcript';
        container.textContent = '';
      }
    }

    function removeInterim() {
      if (interimSpan && interimSpan.parentNode) interimSpan.parentNode.removeChild(interimSpan);
      // If the interim lived alone in a fresh paragraph, drop that paragraph too.
      if (interimHost && interimHost.parentNode && interimHost.childNodes.length === 0) {
        interimHost.parentNode.removeChild(interimHost);
      }
      interimSpan = null;
      interimHost = null;
    }

    function lastPara() {
      return container.lastElementChild;
    }

    return {
      setEmptyText: function (t) {
        emptyText = t;
        if (!paras.length && !interim) showEmpty();
      },
      // Full replace (history replay after refresh) — the one full rebuild.
      setParas: function (arr) {
        paras = (arr || []).slice();
        interim = '';
        forceNew = false;
        if (!paras.length) { showEmpty(); return; }
        container.className = 'transcript';
        container.textContent = '';
        var frag = document.createDocumentFragment();
        for (var i = 0; i < paras.length; i++) {
          var p = document.createElement('p');
          p.textContent = paras[i];
          frag.appendChild(p);
        }
        container.appendChild(frag);
        interimHost = null;
        interimSpan = null;
        pinned = true;
        jump.classList.add('hidden');
        maybeScroll();
      },
      addFinal: function (text, newPara) {
        ensureLiveState();
        removeInterim();
        interim = '';
        if (newPara || forceNew || !paras.length || !lastPara()) {
          paras.push(text);
          var p = document.createElement('p');
          p.textContent = text;
          container.appendChild(p);
        } else {
          paras[paras.length - 1] += ' ' + text;
          lastPara().textContent = paras[paras.length - 1];
        }
        forceNew = false;
        maybeScroll();
      },
      setInterim: function (text) {
        interim = text || '';
        if (!interim) { removeInterim(); if (!paras.length) showEmpty(); return; }
        ensureLiveState();
        if (!interimSpan) {
          interimSpan = document.createElement('span');
          interimSpan.className = 'interim';
          var host = (!forceNew && lastPara()) || null;
          if (!host) {
            host = document.createElement('p');
            container.appendChild(host);
          }
          interimHost = host;
          host.appendChild(interimSpan);
        }
        interimSpan.textContent =
          (interimHost && interimHost.childNodes.length > 1 ? ' ' : '') + interim;
        maybeScroll();
      },
      breakPara: function () {
        // Next interim/final starts a fresh paragraph.
        removeInterim();
        interim = '';
        forceNew = true;
      },
      clear: function () {
        paras = [];
        interim = '';
        forceNew = false;
        showEmpty();
      },
      isEmpty: function () {
        return !paras.length && !interim;
      },
    };
  };
})();
