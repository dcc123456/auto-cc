/* 设计稿专用：深浅主题切换（评审用，非实现代码）
   优先级：URL 参数 ?theme=light|dark > localStorage > 默认深主题 */
(function () {
  var KEY = 'auto-cc-design-theme';
  var html = document.documentElement;

  /** 读取本稿应使用的主题；非法值一律回落深主题。 */
  function initialTheme() {
    var fromUrl = new URLSearchParams(location.search).get('theme');
    if (fromUrl === 'light' || fromUrl === 'dark') return fromUrl;
    try {
      var stored = localStorage.getItem(KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (e) {
      /* file:// 下 localStorage 可能被禁，用默认值 */
    }
    return 'dark';
  }

  /** 把主题写到 <html data-theme> 上，shared.css 靠这个属性换 token。 */
  function apply(theme) {
    html.setAttribute('data-theme', theme);
    var label = document.querySelector('.theme-switch .ts-label');
    if (label) label.textContent = theme === 'light' ? '毡案 · 浅' : '墨案 · 深';
    /* 评审总览：让内嵌的六张稿子跟着换主题（file:// 下访问不到帧内 DOM，只能改 src）*/
    if (document.body.hasAttribute('data-propagate-theme')) {
      document.querySelectorAll('iframe').forEach(function (fr) {
        var base = fr.getAttribute('src').split('?')[0];
        var wanted = base + '?theme=' + theme;
        if (fr.getAttribute('src') !== wanted) fr.setAttribute('src', wanted);
      });
    }
  }

  var theme = initialTheme();
  apply(theme);

  var btn = document.createElement('button');
  btn.className = 'theme-switch';
  btn.type = 'button';
  btn.title = '切换深浅主题（不影响布局与组件）';
  btn.innerHTML = '<span class="ts-dot"></span><span class="ts-label"></span>';
  document.body.appendChild(btn);
  apply(theme);

  btn.addEventListener('click', function () {
    theme = theme === 'light' ? 'dark' : 'light';
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {
      /* 存不下就算了，切换本身已生效 */
    }
  });
})();
