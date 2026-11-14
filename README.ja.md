# HyperFusion

[English](README.md) | [한국어](README.ko.md) | 日本語

![Opusが製図台で計画し、ワーカーモデルがコードを書き、別のモデルがガラスのブースでレビューする](assets/hero.png)

**Opusは計画と検収だけ。コードは他のモデルが書きます。**

HyperFusionはClaude Codeのスキルです。高価なClaude Opus 5.5がチームリーダー（リード）を務め、実装とテストはTerra・Grok・Sonnet・Luna・Haiku・Antigravityといった他のモデル（ワーカー）が行います。レビューは、実装していない別の会社のモデルが担当します。

## なぜ作ったか

Opusがコードを書き、テストを回し、長いログを読むと、高価なトークンがすぐに減ります。その作業は、より安いモデルや別サブスクリプションのモデルでもできます。

そこで仕事を分けます。

- **Opus：** 何を作るかを決め、結果を見て、合格か差し戻しかを決めます。
- **ワーカー：** コードを書き、テストを回します。
- **ユーザー：** Opusとだけ話します。ワーカーの管理はOpusが行います。

> 目標：**Opusのトークンを減らし、品質はそのまま。そのかわり時間はかかってもよい。**

## どう動くか

```text
  ユーザー
    │  「この機能を作って」
    ▼
  リード（Opus）── 作業指示書と合格基準（受け入れテスト）を書く
    │
    ▼
  ワーカー（Terra、Grok、Sonnet …）── コードを書き、テストを回す
    │
    ▼
  コントローラ ── 変わったファイルを自分で比べ、受け入れテストを自分で回す
    │              （ワーカーの「完了しました」は信用しない）
    ▼
  レビュアー（実装していない別のモデル）── 読み取り専用でレビューする
    │
    ▼
  リード（Opus）── 合格 → 終了 ／ 差し戻し → 具体的な修正指示とともにワーカーへ
```

- **受け入れテストはまず失敗しなければなりません。** 作業前に、手を付けていないコードでテストを回し、失敗することを確かめます。最初から通るテストでは何も証明できないからです。
- **差し戻しには理由が必要です。** 「やり直し」だけでは受け付けません。どの基準（AC1、AC2…）がなぜ満たされていないかを書きます。
- **同じミスを2回したワーカーは交代します。**
- **ファイルを編集するのは一度に一人のワーカーだけです。** ラウンドごとにスナップショットを残します。
- **オートパイロット。** ワーカーの実行からレビューまでは自動で進み、リードは判定のときだけ起きます。

## 測定結果

大きな課題5つ（L01〜L05）を同じ条件で実行し、リード（Opus）のトークンを比べました。課題はこのリポジトリの実際の機能コミットから作り、品質はワーカーもリードも見ていない隠しテストで採点しました。

| 課題 | HyperFusionのリードトークン（1回目 / 2回目） | Opus単独（1回目 / 2回目） |
|---|---|---|
| L01 | 221K / 477K | 434K / 414K |
| L02 | 240K / 272K | 642K / 429K |
| L03 | 623K / 736K | 1.04M / 719K |
| L04 | 293K / 131K | 256K / 206K |
| L05 | 149K / 307K | 307K / 411K |
| **合計** | **1.53M / 1.92M（平均1.73M）** | **2.68M / 2.18M（平均2.43M）** |

- **Opusのトークン：** 平均で**約29%少なく**なりました。ただし課題ごとの差は大きく、小さな課題（L04）ではOpus単独のほうが少ないこともありました。
- **品質：** 隠しテストの合格はHyperFusionが48/50（1回目25/25、2回目23/25）、Opus単独が24/25（2回目）でした。
- **時間：** かなり長くかかります。課題1つあたりHyperFusionは17〜108分、Opus単独は3〜7分（2回目）でした。

**読み方と限界**
- トークンは入力換算値です。キャッシュ書き込みは1.25倍、キャッシュ読み込みは0.1倍、出力は5倍として足しています。
- ワーカーが使ったトークンと費用はこの表に入っていません。ワーカーは別サブスクリプションか、より安いモデルで動く前提です。
- それぞれ2回ずつしか実行していません。回の間にスキルも変更しました（2回目には#112と#114が入っています）。
- 2026-11-10〜11、Windows 11の1台で測定しました。
- 方法は[ベンチマーク文書](references/benchmark-pilot.md)にあります。

**ワーカー単独。** リードとレビュアーなしで、同じ5つの課題を各ワーカーに1ラウンドずつ、ワーカーごとに15回任せました（2026-11-14）。隠しテストをすべて通過した回数はTerra 15、Sonnet 15、Grok 13、Gemini 4 Hydrogen 12、Gemini 3.8 Flash 7です。範囲外のファイルを変更した回はありませんでした。そのためAntigravityの既定モデルをHydrogenに変え、HydrogenはB級に置きます。→ [ワーカー能力試験](references/worker-capability-trial.md)（韓国語）

## チーム

| メンバー | モデル | 担当 |
|---|---|---|
| **Opus（リード）** | claude-opus-5-5 | 計画、判定、最終検収。ワーカーが残っている間はコードを書かない |
| Terra | gpt-6.1-terra（Codex） | 中〜高難度のコード、テスト、リファクタ |
| Grok | Grok 4.7 CLI | 実装、画像アセット、レビュー |
| Sonnet | claude-sonnet-5-5 | 実装、レビュー |
| Luna | gpt-6-luna（Codex） | 小さな修正、繰り返しの多い大量編集 |
| Haiku | claude-haiku-5-5 | 易しいコード、ドキュメント、テストの補強 |
| Antigravity | agy（Gemini 4 Hydrogen high） | UI、フロントエンド、ドキュメント |
| Sol | gpt-6.1-sol（Codex） | 主にレビューと相談 |

Fableを使えるプラン（Maxなど）でFableがリードのときは、Opusがレビューと相談のワーカーになり、A級が失敗した作業を引き継ぎます。→ [Fableリード](references/configuration.md#fable-리드와-opus-일꾼)（韓国語）

インストールされたワーカーだけを使い、1つだけでも動きます。この割り当ては出発点で、ワーカーごとの差し戻し記録を見てリードが変えます。→ [配置ルール](references/routing.md)

## インストールと使い方

必要なもの：
- Node.js 24以上
- 初期コミットのあるGitリポジトリ（リモートはなくてもかまいません）
- インストール・認証済みの`claude`、`grok`、`agy`、`codex`のいずれか1つ以上

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Claude CodeでOpus 5.5を選び、次のように使います。

```text
/hyperfusion <作業内容>
/hyperfusion --executor sonnet <作業内容>
```

- **インストールの点検：** `node scripts/setup-doctor.mjs <リポジトリ>`がインストール済みのCLIを見て、合う設定を勧めます。
- **チームファイル：** `--write-team`を付けると、インストール済みのCLIから`~/.hyperfusion/team.json`の下書きを書きます。使うワーカー、モデル、強度はそのファイルで直します。→ [チームファイル](references/configuration.md#이-컴퓨터의-팀-파일-hyperfusionteamjson)（韓国語）
- **設定ファイル：** 対象リポジトリの`hyperfusion.config.json`です。例は`hyperfusion.config.example.json`にあります。
- **リードガードフック（推奨）：** `npm run guard:settings`が出力する`hooks`を`~/.claude/settings.json`にマージします。ワーカーの作業中にリードが自分でファイルを編集するのを防ぎます。→ [詳しく](references/details.ja.md#インストールと使い方)
- **次にすること：** どの段階でも`node scripts/fusion-state.mjs next <リポジトリ>`が次のコマンドを教えてくれます。

## 安全について

- ワーカーに渡す文章では、メール・キー・パスワードのパターンを隠します。
- 作業の状態ファイルはリポジトリの外、`~/.hyperfusion/state/`に置きます。
- 自動のコミット、プッシュ、デプロイはしません。

**これは協業のルールであって、OSのサンドボックスではありません。** シェルを使えるワーカーはリポジトリの外のファイルにも届きます。会社のコードで使うなら、ファイルアクセスと外部送信のポリシーを別に決めてください。→ [セキュリティの詳細](references/details.ja.md#セキュリティ)

## さらに読む

- [詳細説明](references/details.ja.md)：機能の全体、適応型レビュー、ベンダー設定、測定、セキュリティ、テスト
- [CHANGELOG（韓国語）](CHANGELOG.md)：バージョンごとの変更。現在のパッケージバージョンは`0.33.0`です。
- 初めてなら[runtime](references/runtime.md)（コマンド）と[configuration](references/configuration.md)（設定）から読んでください。リード向けの英語の要約は[executor-quickstart](references/executor-quickstart.md)です。

| テーマ | 文書 |
|---|---|
| 状態とコマンド | [runtime](references/runtime.md) · [state-actions](references/state-actions.md) · [operations](references/operations.md) |
| 設定 | [configuration](references/configuration.md) · [codex-runtime](references/codex-runtime.md) |
| ワーカー | [executor-runtime](references/executor-runtime.md) · [routing](references/routing.md) · [herdr](references/herdr.md) |
| 作業指示書と結果 | [delegation-protocol](references/delegation-protocol.md) · [result-protocol](references/result-protocol.md) |
| 検収 | [review-protocol](references/review-protocol.md) · [review-pairs](references/review-pairs.md) · [finding-ledger](references/finding-ledger.md) · [consult](references/consult.md) · [universal-supervisor](references/universal-supervisor.md) |
| 失敗と復旧 | [failure-protocol](references/failure-protocol.md) · [recovery-protocol](references/recovery-protocol.md) · [reconciliation](references/reconciliation.md) |
| プロジェクト・記憶・指標 | [project](references/project.md) · [memory](references/memory.md) · [metrics-policy](references/metrics-policy.md) · [benchmark-pilot](references/benchmark-pilot.md) |

## テストと限界

```sh
npm test
```

- CIはUbuntuとWindowsでNode 24を使って動きます。
- テストの中の`grok`、`agy`、`claude`、`codex`は偽のCLIです。実際のモデルの品質、認証、画像生成はこのテストでは確かめていません。
- 実際のモデルで測った結果は、上の[測定結果](#測定結果)だけです。

ライセンスは[MIT](LICENSE)です。

## 参考にしたもの

- [Orca](https://github.com/stablyai/orca)、[Paseo](https://github.com/getpaseo/paseo)：相談（advisor/committee）、行単位のフィードバック、通知
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp)：記憶レイヤーの設計（重複の統合、矛盾の検討、減衰、出典の表示）
- [cli-dispatch](https://github.com/rbinar/cli-dispatch)：agyのモデル名検証、コンパクション後の状態注入、Codexの残量読み取り
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)：レビュアーにワーカーの主張を渡さないこと、指摘の分類
- [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack)：指摘ごとの処分（Act on / Consider / Noted / Dismissed）
- [mattpocock/skills](https://github.com/mattpocock/skills)：規則と仕様を分けたレビュー、依存グラフによる作業分解
