// ページの処理（app.js）が動き出したかを確かめ、動かなければ理由と直し方を表示する。
// 端末に古いファイルが残っていて新旧が混ざると、モジュールの読み込みでエラーになり、ボタンを押しても何も起きなくなる
// （読み込むファイルの URL には版を付けている（tools/stamp_web_versions.py）が、ページ本体が古いまま残った場合などに備える）。
// i18n.js が読み込めないときにも表示できるよう、文言はこのファイルに持ち、モジュールでない通常のスクリプトにしている。
window.addEventListener("load", () => {
  // モジュールは load より前に実行されるので、ここで印がなければ app.js は最後まで動いていない
  if (document.documentElement.dataset.ready) return;
  const requested = new URLSearchParams(location.search).get("lang"); // i18n.js と同じ決め方
  const ja = requested === "ja" || (requested !== "en" && navigator.language.startsWith("ja"));
  const status = document.getElementById("status");
  status.textContent = ja
    ? `ページを正しく読み込めませんでした。端末に古いデータが残っている可能性があります。ブラウザの設定で、このサイト（${location.hostname}）のデータを消去してから開き直してください。Android の Chrome では「︙」→「設定」→「サイトの設定」→「すべてのサイト」から消去できます。`
    : `The page didn’t load correctly. Old data may be left on this device. Clear the data for this site (${location.hostname}) in your browser settings, then open the page again. In Chrome on Android: ⋮ → Settings → Site settings → All sites.`;
  status.classList.add("error");
});
