# pvcount — ezoe.net の閲覧数(2026-11-19)

ezoe.net(さくら)の glider のページの閲覧数を、外部の解析サービスを使わずに VPS で数える。

```
ezoe.net/glider/*.html ─ pv.js ─▶ https://stats.ezoe.net/pv ─ Caddy(stats.caddy・記録に残さない)─▶ pvcount :3105
                                                                                         └ /var/lib/pvcount/stats.json
管理 VPN(10.77.0.0/24)から https://stats.ezoe.net/stats ─▶ 日ごと・ページごと・参照元の表
```

## 数えるもの・数えないもの

- 送るもの(pv.js): ページの場所(`location.pathname`)と、外のサイトから来たときの参照元のホスト名だけ。
- 残すもの: 日ごと(JST)の閲覧数と人数、ページごとの閲覧数と人数、参照元のホスト名ごとの件数(400 日)。
- 残さないもの: IP・User-Agent・Cookie。人数は「その日だけの使い捨ての鍵 + IP + User-Agent」のハッシュを
  メモリで見分けるだけで、日が変わると鍵ごと捨てる。Caddy も `/pv` は記録に残さない(`log_skip`)。
- 数えないもの: ロボット(User-Agent)・ezoe.net 以外の Origin・JavaScript を動かさないもの・1 人 1 時間 120 回を超える分。
- 再起動するとその日の人数の見分けは最初からになる(閲覧数は 1 分ごとに保存しているので失わない)。

## 設置

1. `sudo sh /home/debian/EZOS/ops/pvcount/install.sh`(本体・systemd・ファイアウォールの 3105 許可)
2. DNS(さくらのゾーン編集)に `stats` の A レコード → VPS の IP(ogn.ezoe.net と同じ)
3. 名前が引けるようになったら `cp stats.caddy /home/debian/saas/caddy/sites/` →
   `sudo docker exec saas-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`
4. ezoe.net 側: `glider/pv.js` と各ページの `<script src="pv.js" defer></script>`、
   `ezoe/.htaccess` の CSP に `connect-src 'self' https://stats.ezoe.net`(2026-11-19 済み)。
   TechLink は build_page.py / build_updates_page.py が同じタグを出す。新しいページを作るときも `</body>` の前に入れる。

## 見る

- 管理 VPN から https://stats.ezoe.net/stats(表)・/stats.json
- VPS で `curl -s http://127.0.0.1:3105/stats.json`

## 止める・戻す

`sudo systemctl disable --now pvcount`、`sites/stats.caddy` を消して reload、各ページのタグと pv.js を消す。
