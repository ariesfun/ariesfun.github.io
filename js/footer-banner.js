/* ==========================================================================
   底部壁纸视差 + 清单热更新
   参考实现：github.com/palxiao/bilibili-banner（相对位移 + 回正动画）

   图层系数由 dashboard-archive/scripts/grab-bili-banner.py 实测写入：
     data-kx  水平位移系数（translateX = moveX * kx）
     data-ks  缩放系数    （scale      = 1 + moveX * ks）

   热更新：页面打开时 fetch /bili-banner.json，指纹变了就用新清单重建图层
          —— 这样清单更新后无需重新构建站点，访客下次打开即见新壁纸。

   交互按设备区分：
     有鼠标  → mousemove（相对进入点）+ 离开页面/失焦时回正
     触摸屏  → touchmove（手指滑动）+ deviceorientation（倾斜）
   ========================================================================== */
(function () {
  'use strict';

  var box = document.getElementById('bili-banner');
  if (!box) return;

  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
  var HOMING_MS = 320;         // 回正动画时长

  var items = [];

  /* 收集各层及其系数 */
  function collect() {
    items = [];
    var layers = box.querySelectorAll('.bili-layer');
    Array.prototype.forEach.call(layers, function (el) {
      // Butterfly 主题构建时会把 src 换成占位图（data-lazy-src 存真实 URL）
      // 这里恢复为真实 URL，否则图片永远显示 1x1 透明像素
      var realSrc = el.getAttribute('data-lazy-src');
      if (realSrc && el.src.indexOf('data:image/gif') === 0) {
        el.src = realSrc;
      }
      items.push({
        el: el,
        kx: parseFloat(el.getAttribute('data-kx')) || 0,
        ks: parseFloat(el.getAttribute('data-ks')) || 0
      });
    });
  }

  /* 按位移量套用各层变换；progress 为 null 表示直接跟随，
     传 0~1 表示正在回正（从当前位置线性衰减到 0） */
  function apply(moveX, progress) {
    var damp = progress == null ? 1 : (1 - progress);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      it.el.style.setProperty('--px', (it.kx * moveX * damp).toFixed(2) + 'px');
      it.el.style.setProperty('--ps', (1 + it.ks * moveX * damp).toFixed(5));
    }
  }

  /* 用新清单重建图层（热更新用） */
  function rebuild(layers, fp) {
    var frag = document.createDocumentFragment();
    layers.forEach(function (l, i) {
      var img = document.createElement('img');
      img.className = 'bili-layer';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';   // B 站 CDN 有防盗链，必须不带 Referer
      img.setAttribute('data-kx', l.kx);
      img.setAttribute('data-ks', l.ks);
      img.style.zIndex = String(i + 1);
      img.src = l.url;
      frag.appendChild(img);
    });
    box.innerHTML = '';
    box.appendChild(frag);
    if (fp) box.setAttribute('data-fingerprint', fp);
    collect();
  }

  collect();
  if (!items.length) return;

  /* 等待所有图片加载完成后再启用视差，避免线上 CDN 加载过程中闪烁 */
  function waitForImages(done) {
    var loaded = 0;
    var total = items.length;
    function check() {
      loaded++;
      if (loaded >= total) done();
    }
    items.forEach(function (it) {
      if (it.el.complete && it.el.naturalWidth > 0) {
        check();
      } else {
        it.el.addEventListener('load', function handler() {
          it.el.removeEventListener('load', handler);
          check();
        });
        it.el.addEventListener('error', function handler() {
          it.el.removeEventListener('error', handler);
          check();
        });
      }
    });
  }

  /* ── 运行时热更新：清单指纹变了就重建，无需重新构建站点 ── */
  if (typeof window.fetch === 'function') {
    fetch('/bili-banner.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.layers || !data.layers.length) return;
        var cur = box.getAttribute('data-fingerprint');
        if (data.fingerprint && data.fingerprint === cur) return;   // 壁纸没变
        rebuild(data.layers, data.fingerprint);
      })
      .catch(function () { /* 静默：继续用构建时内联的兜底数据 */ });
  }

  /* ── 桌面：相对「鼠标进入页面的位置」跟随；离开页面 / 失焦时回正 ── */
  function bindMouse() {
    var enterX = null;
    var moveX = 0;
    var ticking = false;

    function schedule() {
      if (ticking) return;
      ticking = true;
      raf(function () { ticking = false; apply(moveX, null); });
    }

    window.addEventListener('mousemove', function (e) {
      if (enterX == null) enterX = e.clientX;   // 首次移动即作为基准点
      moveX = e.clientX - enterX;
      schedule();
    }, { passive: true });

    function homing(t0) {
      raf(function (ts) {
        var start = t0 || ts;
        var p = Math.min((ts - start) / HOMING_MS, 1);
        apply(moveX, p);
        if (p < 1) homing(start);
        else { moveX = 0; enterX = null; }
      });
    }

    // 绑在 document 上：鼠标离开页面 / 切走窗口时才回正，页面内移动不受影响
    document.addEventListener('mouseleave', function () { homing(0); });
    window.addEventListener('blur', function () { homing(0); });
  }

  /* ── 触摸设备：滑动 / 倾斜 ── */
  function bindTouch() {
    var ticking = false;
    var pending = 0;

    function schedule(dx) {
      pending = dx;
      if (ticking) return;
      ticking = true;
      raf(function () { ticking = false; apply(pending, null); });
    }

    window.addEventListener('touchmove', function (e) {
      if (!e.touches || !e.touches.length) return;
      var r = box.getBoundingClientRect();
      schedule(e.touches[0].clientX - (r.left + r.width / 2));
    }, { passive: true });

    // 松手后回正
    window.addEventListener('touchend', function () {
      var from = pending;
      var t0 = null;
      (function homing(ts) {
        raf(function (now) {
          if (t0 === null) t0 = now;
          var p = Math.min((now - t0) / HOMING_MS, 1);
          apply(from, p);
          if (p < 1) homing(now);
          else pending = 0;
        });
      })();
    }, { passive: true });

    // 倾斜手机：左右倾角映射成等效水平位移
    function onTilt(e) {
      if (e.gamma == null) return;
      schedule(Math.max(-90, Math.min(90, e.gamma)) * 12);
    }

    if (typeof DeviceOrientationEvent === 'undefined') return;

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS 13+ 需用户手势后才能申请权限；被拒则只保留触摸视差
      var ask = function () {
        DeviceOrientationEvent.requestPermission().then(function (state) {
          if (state === 'granted') {
            window.addEventListener('deviceorientation', onTilt, { passive: true });
          }
        }).catch(function () { /* 忽略 */ });
        window.removeEventListener('touchend', ask);
      };
      window.addEventListener('touchend', ask, { passive: true });
    } else {
      window.addEventListener('deviceorientation', onTilt, { passive: true });
    }
  }

  waitForImages(function () {
    var canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
    if (canHover) bindMouse();
    else bindTouch();
  });
})();
