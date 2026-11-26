# HyperFusion

[English](README.md) | [한국어](README.ko.md) | 日本語

![Opus が製図台で計画を立て、ワーカーモデルがコードを書き、別のモデルがガラスのブースでレビューする](assets/hero.png)

**Opus は計画とレビューに専念し、コードは他のモデルが書きます。**

HyperFusion は Claude Code 向けのスキルです。高コストな Claude Opus 5.5 がチームリーダー（リード）を務め、実装とテストは Terra・Grok・Sonnet・Luna・Haiku・Antigravity といった他のモデル（ワーカー）が担当します。レビューは、コードを書いていない別ベンダーのモデルに任せます。

## 目的

Opus にコードを書かせ、テストを回し、長いログを読ませると、高価なトークンをすぐ消費してしまいます。そうした作業は、より安価なモデルや別サブスクリプションのモデルでもこなせます。

そこで役割を分けます。

- **Opus：** 何を作るかを決め、結果をレビューし、合格か差し戻しかを判定します。
- **ワーカー：** コードを書き、テストを実行します。
- **ユーザー：** Opus とだけやり取りします。ワーカーの管理は Opus が引き受けます。

> 目標：**所要時間は延びても、品質を保ったまま Opus のトークン消費を抑える。**

## 仕組み

```text
  ユーザー
    │  「この機能を作って」
    ▼
  リード（Opus）── 作業指示書と合格基準（受け入れテスト）を書く
    │
    ▼
  ワーカー（Terra、Grok、Sonnet …）── コードを書き、テストを実行する
    │
    ▼
  コントローラ ── 変更ファイルを直接比較し、受け入れテストを自ら実行する
    │              （ワーカーの「完了しました」は信用しない）
    ▼
  レビュアー（実装していない別モデル）── 読み取り専用でレビューする
    │
    ▼
  リード（Opus）── 合格 → 終了 ／ 差し戻し → 具体的な修正指示を添えてワーカーへ戻す
```

- **受け入れテストは最初に失敗する必要があります。** 作業前に手を加えていないコードでテストを回し、失敗することを確かめます。最初から通るテストでは何も証明できないためです。
- **差し戻しには理由が必須です。** 「やり直し」だけでは受け付けず、どの基準（`AC1`、`AC2` …）がなぜ満たされていないかを明記します。
- **同じミスを 2 回繰り返したワーカーは交代させます。**
- **ファイルを編集できるのは一度に 1 つのワーカーだけです。** ラウンドごとにスナップショットを残します。
- **オートパイロット。** ワーカーの実行からレビューまでは自動で進み、リードは判定が必要なときだけ介入します。

## 測定結果

大きめの課題 5 つ（`L01`〜`L05`）を同じ条件で実行し、リード（Opus）のトークン消費量を比べました。課題はこのリポジトリの実際の機能コミットから作成し、品質はワーカーもリードも見ていない隠しテストで採点しています。

| 課題 | HyperFusion のリードトークン（1 回目 / 2 回目） | Opus 単独（1 回目 / 2 回目） |
|---|---|---|
| L01 | 221K / 477K | 434K / 414K |
| L02 | 240K / 272K | 642K / 429K |
| L03 | 623K / 736K | 1.04M / 719K |
| L04 | 293K / 131K | 256K / 206K |
| L05 | 149K / 307K | 307K / 411K |
| **合計** | **1.53M / 1.92M（平均 1.73M）** | **2.68M / 2.18M（平均 2.43M）** |

- **Opus のトークン：** 平均で**約 29% 削減**できました。ただし課題によるばらつきは大きく、最も小さい課題（`L04`）では Opus 単独のほうが少ない場合もありました。
- **品質：** 隠しテストの合格数は HyperFusion が 48/50（1 回目 25/25、2 回目 23/25）、Opus 単独が 24/25（2 回目）でした。
- **所要時間：** 大きく延びます。課題 1 件あたり HyperFusion は 17〜108 分、Opus 単独は 3〜7 分（2 回目）かかりました。

### 読み方と限界

- トークン数は入力換算値です。キャッシュ書き込みは 1.25 倍、キャッシュ読み込みは 0.1 倍、出力は 5 倍として合算しています。
- ワーカーが使ったトークンと費用は表に含めていません。ワーカーは別サブスクリプションや、より安価なモデルで動かす前提です。
- 各構成とも 2 回ずつしか実行していません。また、1 回目と 2 回目の間でスキルを更新しており、2 回目にはワーカーに関連テストだけを実行させる [#112](https://github.com/prentice7725/hyperfusion/pull/112) と、ワーカー・レビュアーに境界チェックリストを渡す [#114](https://github.com/prentice7725/hyperfusion/pull/114) が入っています。
- 2026-11-10〜11 にかけて、Windows 11 マシン 1 台で測定しました。
- 手法の詳細は[ベンチマーク文書](references/benchmark-pilot.md)（英語）を参照してください。

### ワーカー単独

リードもレビュアーも置かずに、同じ 5 つの課題を各ワーカーへ 1 ラウンドずつ、ワーカーごとに 15 回実行しました（2026-11-14）。隠しテストを全問通過した回数は Terra 15、Sonnet 15、Grok 13、Gemini 4 Hydrogen 12、Gemini 3.8 Flash 7 で、範囲外のファイルを編集した回はありませんでした。この結果を受けて Antigravity の既定モデルを Hydrogen に切り替えましたが、A 級で最も低い Grok（13）に届かないため B 級にとどめています（[等級](#チーム)）。→ [ワーカー能力試験](references/archive/worker-capability-trial.md)（韓国語）

## チーム

| メンバー | モデル | 担当 |
|---|---|---|
| **Opus（リード）** | `claude-opus-5-5` | 計画、判定、最終確認。ワーカーに予算が残っている間はコードを書かない |
| Terra | `gpt-6.1-terra`（Codex） | 中〜高難度のコード、テスト、リファクタリング |
| Grok | Grok 4.7 CLI | 実装、画像アセット、レビュー |
| Sonnet | `claude-sonnet-5-5` | 実装、レビュー |
| Luna | `gpt-6-luna`（Codex） | 小さな修正、繰り返しの多い一括編集 |
| Haiku | `claude-haiku-5-5` | 易しいコード、ドキュメント、テスト補強 |
| Antigravity | `agy`（Gemini 4 Hydrogen high） | UI、フロントエンド、ドキュメント。個人の Google プランでは使わない（[安全について](#安全について)を参照） |
| Sol | `gpt-6.1-sol`（Codex） | 主にレビューと相談 |

### 等級と割り当て

- **等級：** A 級は Terra・Grok・Sonnet、B 級は Luna・Haiku・Antigravity です。易しい実装、UI、ドキュメントは B 級から任せ、B 級のラウンドが差し戻されたら A 級へ回します。
- **Fable リード：** Fable が使えるプラン（Max など）で Fable がリードになるときは、Opus がレビューと相談のワーカーに回り、A 級が失敗した作業を引き継ぎます。→ [Fable リード](references/configuration.md#fable-리드와-opus-일꾼)（韓国語）
- **適応的な割り当て：** インストール済みのワーカーだけを使い、1 つだけでも動きます。表の担当は出発点にすぎず、ワーカーごとの差し戻し履歴を見てリードが割り当てを調整します。→ [配置ルール](references/routing.md)（韓国語）

## インストールと使い方

### 前提条件

- Node.js 24 以上
- 初期コミットのある Git リポジトリ（リモートは不要）
- インストール・認証済みの `claude`、`grok`、`agy`、`codex` のいずれか 1 つ以上（`agy` は個人の Google プランでは使わないでください。→ [安全について](#安全について)）

### インストール

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

### 実行

Claude Code で Opus 5.5 を選び、次のように呼び出します。

```text
/hyperfusion <作業内容>
/hyperfusion --executor sonnet <作業内容>
```

どの段階でも、`node scripts/fusion-state.mjs next <リポジトリ>` を実行すると次のコマンドが表示されます。

### 設定とガードフック

- **環境チェック：** `node scripts/setup-doctor.mjs <リポジトリ>` がインストール済みの CLI を調べ、合う設定を提案します。
- **チームファイル：** `--write-team` を付けると、インストール済みの CLI から `~/.hyperfusion/team.json` の下書きを作ります。使うワーカー、モデル、推論強度はこのファイルで調整します。→ [チームファイル](references/configuration.md#이-컴퓨터의-팀-파일-hyperfusionteamjson)（韓国語）
- **リポジトリ設定：** 対象リポジトリの `hyperfusion.config.json` に置きます。例は `hyperfusion.config.example.json` にあります。
- **リードガードフック（推奨）：** `npm run guard:settings` が出力する `hooks` を `~/.claude/settings.json` にマージします。ワーカーに lease や予算が残っている間、リードが Edit・Write ツールでファイルを編集しないようブロックします。Bash での書き込みは止めず、ラウンド間のスナップショット比較で検出します。→ [詳細](references/details.ja.md#インストールと使い方)

## 安全について

### マスキングと状態管理

- ワーカーに渡すテキストでは、メール・IP・API キー・パスワードのパターンに加え、韓国と日本の個人識別番号（マイナンバー、住民登録番号・外国人登録番号、電話番号、カード番号、銀行口座、旅券、運転免許証、在留カード、基礎年金番号）をマスクします。
- 作業の状態ファイルはリポジトリの外、`~/.hyperfusion/state/` に保存します。
- 自動でコミット、プッシュ、デプロイはしません。

### セキュリティの境界

**これは協業のためのルールであり、OS のサンドボックスではありません。** シェルを使えるワーカーはリポジトリ外のファイルにもアクセスできます。業務コードで使う場合は、ファイルアクセスと外部送信のポリシーを別途設けてください。→ [セキュリティの詳細](references/details.ja.md#セキュリティ)

### 個人の Google プランでの Antigravity 利用

**個人の Google プランでは Antigravity をワーカーとして使わないでください。** 2026-11-09、Google のスタッフは、Claude Code のようなサードパーティ製エージェントが個人プラン（Free、Pro、Ultra）で `agy -p` を呼び出す行為は Antigravity 利用規約第 6 条に違反し、自動のアカウント停止につながりうると[回答しました](https://discuss.ai.google.dev/t/terms-section-6-may-a-local-script-run-the-official-agy-cli-when-launched-by-another-vendors-ai-tool/199021)。HyperFusion が Antigravity にラウンドを任せる仕組みはまさにこの形態であり、呼び出し間隔を空けても変わりません。

チームファイルでこのワーカーを無効にするか（`"antigravity": {"enabled": false}`）、Google API キー、Vertex AI、Gemini Enterprise を利用してください。なお、`agy` が API キーで動作するかは HyperFusion では検証していません。それでもアカウント停止のメッセージが出た場合、HyperFusion はオペレーターが `setup-doctor --clear-suspension agy` で解除するまで、そのマシンで `agy` を起動しません。→ [チームファイル](references/configuration.md#자리-제한과-호출-간격)（韓国語）

## 関連ドキュメント

- [詳細説明](references/details.ja.md)：全機能、適応型レビュー、ベンダー設定、測定、セキュリティ、テスト
- [CHANGELOG](CHANGELOG.md)（韓国語）：バージョンごとの変更履歴。現在のパッケージバージョンは `0.35.0` です。
- 初めて使う場合は [runtime](references/runtime.md)（韓国語・コマンド）と [configuration](references/configuration.md)（韓国語・設定）からご覧ください。リード向けの英語サマリーは [executor-quickstart](references/executor-quickstart.md)（英語）です。

下の表では、`(ko)` が韓国語、`(en)` が英語のドキュメントを指します。

| テーマ | ドキュメント |
|---|---|
| 状態とコマンド | [runtime](references/runtime.md) `(ko)` · [state-actions](references/state-actions.md) `(en)` · [operations](references/operations.md) `(ko)` |
| 設定 | [configuration](references/configuration.md) `(ko)` · [codex-runtime](references/codex-runtime.md) `(en)` |
| ワーカー | [executor-runtime](references/executor-runtime.md) `(ko)` · [routing](references/routing.md) `(ko)` · [herdr](references/herdr.md) `(ko)` |
| 作業指示書と結果 | [delegation-protocol](references/delegation-protocol.md) `(ko)` · [result-protocol](references/result-protocol.md) `(ko)` |
| レビュー | [review-protocol](references/review-protocol.md) `(ko)` · [review-pairs](references/review-pairs.md) `(en)` · [finding-ledger](references/finding-ledger.md) `(en)` · [consult](references/consult.md) `(ko)` · [universal-supervisor](references/universal-supervisor.md) `(ko)` |
| 失敗と復旧 | [failure-protocol](references/failure-protocol.md) `(ko)` · [recovery-protocol](references/recovery-protocol.md) `(ko)` · [reconciliation](references/reconciliation.md) `(en)` |
| プロジェクト・メモリ・指標 | [project](references/project.md) `(ko)` · [memory](references/memory.md) `(ko)` · [metrics-policy](references/metrics-policy.md) `(ko)` · [benchmark-pilot](references/benchmark-pilot.md) `(en)` |

## テストと制約

```sh
npm test
```

- CI は Ubuntu と Windows 上の Node 24 で実行します。
- テスト内の `grok`、`agy`、`claude`、`codex` はモック CLI です。実モデルの品質、認証、画像生成はこのテストでは検証しません。
- 実モデルで測定した結果は、上の[測定結果](#測定結果)だけです。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。

## 参考にしたプロジェクト

- [Orca](https://github.com/stablyai/orca)、[Paseo](https://github.com/getpaseo/paseo)：アドバイザー／委員会による相談、行単位のフィードバック、通知
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp)：メモリ階層の設計（重複の統合、矛盾の検証、減衰、出典の保持）
- [cli-dispatch](https://github.com/rbinar/cli-dispatch)：`agy` のモデル名検証、コンパクション後の状態注入、Codex の残量読み取り
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)：レビュアーにワーカーの主張を渡さない設計、指摘の分類
- [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack)：指摘ごとの対応区分（`Act on` / `Consider` / `Noted` / `Dismissed`）
- [mattpocock/skills](https://github.com/mattpocock/skills)：規約と仕様に分けたレビュー、依存グラフに基づくタスク分解
