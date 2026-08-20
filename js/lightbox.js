/**
 * lightbox.js — 图片弹窗查看器
 *
 * 点击文章/页面正文（.post__content / .page__content）中的图片，
 * 弹出全屏查看器。同一容器内的所有图片自动组成一组，支持：
 *   - 手机端触摸左右滑动切换
 *   - 桌面端左右箭头按钮
 *   - 键盘 ← / → 切换，Esc 关闭
 *
 * 无任何第三方依赖，原生 JavaScript。
 */
(function () {
  'use strict';

  var SWIPE_THRESHOLD = 60;    // 触发切换的最小水平位移(px)
  var LOCK_DIRECTION_AT = 10;  // 判定滑动方向的起始位移(px)
  var EDGE_FRICTION = 0.3;     // 首/末图边缘拖动的阻尼系数
  var FLING_SPEED = 0.5;       // 快速轻扫判定速度(px/ms)
  var MAX_CAPTION = 120;       // 副标题（正文第一段）最大长度

  var gallery = [];  // 当前打开的图片列表 [{ src, alt, caption }]
  var index = 0;     // 当前图片索引
  var isOpen = false;
  var loadToken = 0; // 防止快速切换时旧图片的 onload 覆盖新图

  // DOM 引用
  var lightboxEl, stageEl, imageEl, captionEl, counterEl, prevBtn, nextBtn;

  // 触摸状态
  var touchStartX = 0;
  var touchStartY = 0;
  var dragX = 0;
  var isDragging = false;
  var isHorizontal = false;
  var lastMoveX = 0;
  var lastMoveTime = 0;
  var velocityX = 0;

  /* ---------------- 构建 DOM ---------------- */
  function buildLightbox() {
    var div = document.createElement('div');
    div.className = 'lightbox';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-modal', 'true');
    div.setAttribute('aria-label', 'Image viewer');
    div.innerHTML =
      '<button class="lightbox__close" type="button" aria-label="Close">&#10005;</button>' +
      '<button class="lightbox__nav lightbox__nav--prev" type="button" aria-label="Previous">&#10094;</button>' +
      '<button class="lightbox__nav lightbox__nav--next" type="button" aria-label="Next">&#10095;</button>' +
      '<div class="lightbox__stage">' +
        '<img class="lightbox__image" src="" alt="">' +
      '</div>' +
      '<div class="lightbox__bar">' +
        '<span class="lightbox__counter"></span>' +
        '<span class="lightbox__caption"></span>' +
      '</div>';

    document.body.appendChild(div);

    lightboxEl = div;
    imageEl = div.querySelector('.lightbox__image');
    captionEl = div.querySelector('.lightbox__caption');
    counterEl = div.querySelector('.lightbox__counter');
    prevBtn = div.querySelector('.lightbox__nav--prev');
    nextBtn = div.querySelector('.lightbox__nav--next');
    stageEl = div.querySelector('.lightbox__stage');

    // 关闭按钮
    div.querySelector('.lightbox__close').addEventListener('click', function (e) {
      e.stopPropagation();
      close();
    });

    // 左右切换按钮
    prevBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      goTo(index - 1);
    });
    nextBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      goTo(index + 1);
    });

    // 点击遮罩空白处关闭
    div.addEventListener('click', function (e) {
      if (e.target === div || e.target === stageEl) {
        close();
      }
    });

    // 键盘
    document.addEventListener('keydown', onKeydown);

    // 触摸（图片上的手势控制，阻止页面滚动）
    stageEl.addEventListener('touchstart', onTouchStart, { passive: false });
    stageEl.addEventListener('touchmove', onTouchMove, { passive: false });
    stageEl.addEventListener('touchend', onTouchEnd);
    stageEl.addEventListener('touchcancel', onTouchEnd);
  }

  /* ---------------- 初始化：扫描图片并分组 ---------------- */
  function init() {
    buildLightbox();

    var containers = document.querySelectorAll('.post__content, .page__content');

    Array.prototype.forEach.call(containers, function (container) {
      var images = container.querySelectorAll('img');
      var list = [];

      Array.prototype.forEach.call(images, function (img, i) {
        // 跳过被链接包裹的图片（它们是跳转链接，不弹窗）
        if (img.closest && img.closest('a')) {
          return;
        }
        list.push({
          src: img.currentSrc || img.src,
          alt: img.alt || img.getAttribute('data-title') || '',
          // 每张图片的注释：图片下方斜体说明 / 回退 alt
          caption: getImageCaption(img, container)
        });
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', function () {
          open(list, i);
        });
      });
    });
  }

  /* ---------------- 图片注释提取 ---------------- */
  // 规则：优先取紧跟在图片所在段落之后、纯斜体（<em>）包裹的说明文字
  // （markdown `![img]` 后 `*cap*` 渲染为 <p><img></p><p><em>cap</em></p>）；
  // 没有说明文字时回退到图片的 alt / data-title。
  function getImageCaption(img, container) {
    // 向上找到包含该图片的段落
    var node = img.parentNode;
    while (node && node !== container && node.nodeType === 1 &&
           node.tagName !== 'P' && node.tagName !== 'FIGURE') {
      node = node.parentNode;
    }
    if (!node || node === container) {
      return img.alt || img.getAttribute('data-title') || '';
    }

    // <figure><figcaption>…</figcaption></figure> 结构
    if (node.tagName === 'FIGURE') {
      var figCaption = node.querySelector('figcaption');
      if (figCaption) {
        var figText = (figCaption.textContent || '').replace(/\s+/g, ' ').trim();
        if (figText) { return truncateText(figText, MAX_CAPTION); }
      }
      return img.alt || img.getAttribute('data-title') || '';
    }

    // <p><img></p> 后紧跟 <p><em>说明</em></p>：跳过空段找第一个说明段落
    var sibling = node.nextElementSibling;
    while (sibling) {
      var tag = sibling.tagName;
      var text = (sibling.textContent || '').replace(/\s+/g, ' ').trim();

      if (!text) { // 空段落跳过
        sibling = sibling.nextElementSibling;
        continue;
      }

      if (tag === 'P' || tag === 'BLOCKQUOTE') {
        var onlyEm = sibling.children.length === 1 && sibling.children[0].tagName === 'EM';
        if (onlyEm) {
          return truncateText(text, MAX_CAPTION);
        }
        break; // 非纯斜体段落：说明到此为止
      }

      sibling = sibling.nextElementSibling;
    }

    // 回退：alt 文本
    return img.alt || img.getAttribute('data-title') || '';
  }

  function truncateText(text, max) {
    if (text.length <= max) { return text; }
    return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
  }

  /* ---------------- 打开 / 关闭 ---------------- */
  function open(list, startIndex) {
    gallery = list;
    index = startIndex;
    isOpen = true;
    lightboxEl.classList.add('is-open');
    document.body.classList.add('lightbox-open');
    document.documentElement.classList.add('lightbox-open');
    goTo(startIndex);
  }

  function close() {
    if (!isOpen) { return; }
    isOpen = false;
    lightboxEl.classList.remove('is-open');
    document.body.classList.remove('lightbox-open');
    document.documentElement.classList.remove('lightbox-open');
    // 等淡出过渡结束后再清空，避免闪烁
    setTimeout(function () {
      if (!isOpen) {
        imageEl.src = '';
        imageEl.style.opacity = 0;
        gallery = [];
      }
    }, 350);
  }

  /* ---------------- 切换图片 ---------------- */
  function goTo(i) {
    if (i < 0 || i >= gallery.length) { return; }
    index = i;
    var item = gallery[index];
    var token = ++loadToken;

    // 淡出当前图，显示加载指示器
    imageEl.style.opacity = 0;
    stageEl.classList.add('is-loading');

    // 信息条：注释显示当前图片自身的说明（图片下方斜体注释 / alt）
    counterEl.textContent = (index + 1) + ' / ' + gallery.length;
    var caption = item.caption || '';
    captionEl.textContent = caption;
    captionEl.style.display = caption ? '' : 'none';

    // 箭头可用性
    prevBtn.classList.toggle('is-disabled', index === 0);
    nextBtn.classList.toggle('is-disabled', index === gallery.length - 1);

    // 预加载相邻图片
    preload(index + 1);
    preload(index - 1);

    var loader = new Image();
    loader.onload = function () {
      if (token !== loadToken) { return; }
      imageEl.src = item.src;
      imageEl.alt = item.alt || '';
      requestAnimationFrame(function () {
        imageEl.style.opacity = 1;
        stageEl.classList.remove('is-loading');
      });
    };
    loader.src = item.src;
  }

  function preload(i) {
    if (i < 0 || i >= gallery.length) { return; }
    var img = new Image();
    img.src = gallery[i].src;
  }

  function next() { goTo(index + 1); }
  function prev() { goTo(index - 1); }

  /* ---------------- 键盘 ---------------- */
  function onKeydown(e) {
    if (!isOpen) { return; }
    switch (e.key) {
      case 'Escape':
        close();
        break;
      case 'ArrowLeft':
        prev();
        break;
      case 'ArrowRight':
        next();
        break;
    }
  }

  /* ---------------- 触摸滑动 ---------------- */
  function onTouchStart(e) {
    if (!isOpen) { return; }
    var touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    dragX = 0;
    isDragging = true;
    isHorizontal = false;
    lastMoveX = touch.clientX;
    lastMoveTime = Date.now();
    velocityX = 0;
    imageEl.classList.add('is-dragging');
  }

  function onTouchMove(e) {
    if (!isDragging) { return; }
    var touch = e.touches[0];
    var dx = touch.clientX - touchStartX;
    var dy = touch.clientY - touchStartY;

    if (!isHorizontal) {
      if (Math.abs(dx) > LOCK_DIRECTION_AT && Math.abs(dx) > Math.abs(dy)) {
        // 水平滑动：锁定横向拖动
        isHorizontal = true;
      } else if (Math.abs(dy) > LOCK_DIRECTION_AT) {
        // 垂直手势：交给浏览器（恢复页面滚动），结束本次拖动
        isDragging = false;
        imageEl.classList.remove('is-dragging');
        imageEl.style.transform = '';
        return;
      }
    }

    if (isHorizontal) {
      e.preventDefault();
      dragX = dx;
      // 计算滑动速度（用于快速轻扫判定）
      var now = Date.now();
      var dt = now - lastMoveTime;
      if (dt > 0) {
        velocityX = (touch.clientX - lastMoveX) / dt;
      }
      lastMoveX = touch.clientX;
      lastMoveTime = now;
      // 首/末图边缘加阻尼，避免“空滑”
      var atEdge = (index === 0 && dx > 0) || (index === gallery.length - 1 && dx < 0);
      var offset = atEdge ? dx * EDGE_FRICTION : dx;
      imageEl.style.transform = 'translateX(' + offset + 'px)';
    }
  }

  function onTouchEnd() {
    if (!isDragging) { return; }
    isDragging = false;
    imageEl.classList.remove('is-dragging');
    imageEl.style.transform = '';

    if (isHorizontal) {
      // 位移超过阈值，或快速轻扫（fling）时也切换
      var shouldNext = dragX < -SWIPE_THRESHOLD || (velocityX < -FLING_SPEED && Math.abs(dragX) > 10);
      var shouldPrev = dragX > SWIPE_THRESHOLD || (velocityX > FLING_SPEED && Math.abs(dragX) > 10);
      if (shouldNext && index < gallery.length - 1) {
        next();
      } else if (shouldPrev && index > 0) {
        prev();
      }
    }
  }

  /* ---------------- 启动 ---------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
