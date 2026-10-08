# HyperFusion

[한국어](README.md) | 日本語

**Claude Opus 5.5がリード**を務め、**Grok・Antigravity・Sonnetがワーカー**として実装とテストをすべて担当するClaude Codeスキルです。リードは作業の種類と難易度に応じてワーカーを選んで投入します（画像アセットはGrok、難しいコーディングはSonnet、UIはAntigravity など）。

リードが行うのは計画・差し戻し・最終検収のみです。ワーカーに予算が残っている限り、リードはコードを書きません。差し戻す際は具体的な指示書を必ず添え、同じミスを2回繰り返したワーカーは別のワーカーに交代されます。ワーカーの「完了しました」は、スナップショット差分とリードによる再実行でのみ認められます。

> v0.2.1までは、GPT-6.1 Sol（Codex）がリード、Claude Codeがワーカーを務める構成でした。v0.4から役割を反転させ、Opusがリードを務めています。

## 特徴

- **単一writer＋監査**：状態機械、writer lease、スナップショット監査により、作業ツリーを書き換えられるのは常に1者だけ
- **自動ルーティング**：作業種別・難易度・インストール状況・過去の成功率をもとにワーカーを自動選択
- **差し戻しの品質担保**：理由のない差し戻しを禁止し、同じ理由で2回続けて差し戻されたワーカーは自動交代
- **共有作業メモリ**：ワーカー間・セッション間で試行錯誤の知見を引き継ぐ記憶層（外部サーバー・DB不要）
- **レビュー委任**：リードはOpusのまま、ラウンドのレビューだけを別モデル（既定はCodex優先）に任せるオプション
- **相談機能**：別ワーカーによる読み取り専用のdiffレビュー（advisor）や、2者並列の原因分析（committee）
- **クロスプラットフォーム**：Linux・macOS・Windowsに対応し、CIでUbuntu・Windows × Node 20・24を検証

## v0.2.1の評価

| 項目 | 評価 |
|---|---|
| 状態機械・writer lease・スナップショット監査 | 堅牢。一度だけ作成される成果物、原子的な状態保存、範囲/HEAD/indexの検証、重複実行防止がよく設計されている → **そのまま継承** |
| 実行者の多様性 | Claudeのみ。Grok・Antigravityは`ADAPTER_UNAVAILABLE`としてのみ存在し、実質的に単一ワーカーで代替経路が機能していなかった |
| リードの介入 | Luna helperとtakeover経路があり、リード側が作業を抱え込みやすい |
| 差し戻しの品質 | 理由なしでもやり直しが可能で、同じミスの繰り返しを防ぐ仕組みがない |
| コードの可読性 | 1行にロジックを詰め込む圧縮スタイル。動作は正しいがレビューコストが高い |
| テスト | 36件通過。代替CLIでプロセス/プロトコルのみを検証し、実際のモデル呼び出しはない（その旨を明記） |

## レビュー委任（v0.8）

リードはOpusのまま、ラウンドのレビューだけを別のモデルに任せるオプションです（`"review": {"by": "delegate"}`）。リードのトークンで最も大きいのは、Opusがdiffを精読するコストだからです。

- **判定の適用**：レビュアーが読み取り専用でdiffを確認し、判定（pass/redo/alternative/decision）、差し戻し理由、ファイル・行単位の指摘を返します。コントローラーはその判定をそのまま適用します（`auto_apply: false`の場合は、リードが採用するか上書きします）。
- **レビュアーの順序**：既定は**Codex**（GPT。リードと系統が異なるため相互検証に最も有利）→ Sonnet → Antigravity → Grokです。インストールされていないレビュアーはスキップします。Codexはレビューと相談のみを行い、コードは書きません。
- **自己レビューの禁止**：そのラウンドを実装したワーカーはレビュアーになれません。リードがtakeoverで書いたコードも別のモデルがレビューします。
- **リードに残るもの**：takeover、設計判断（decision）、最終VERIFY（テストの直接実行）、そしていつでも上書きできる権限です。上書きした回数はmetricsの`lead_overrides`に記録されます。
- **指示の再利用**：次のラウンドでは`"lead_feedback": "@review"`で、レビュアーの指摘をそのまま渡せます。
- **安全装置**：
  - レビュアーがツリーを変更した場合、その判定は破棄します。
  - 形式が誤っている場合や失敗した場合は次のレビュアーに回します（1ラウンドあたり2回まで）。それでも駄目ならリードが確認します。
  - 適用できない判定は保留します。

詳しくは[review-protocol](references/review-protocol.md)を参照してください。

## ワーカー配置（v0.4）

| 作業 | 第1候補 → 予備 |
|---|---|
| 画像アセット（`image-asset`） | Grok → Antigravity |
| 中・高難度のコード（`code` medium/high） | Sonnet → Grok → Antigravity |
| 簡単なコード（`code` low） | Grok → Antigravity → Sonnet |
| テスト / リファクタリング | Sonnet → … |
| UI / ドキュメント | Antigravity → … |

- briefの`task_kind`と`difficulty`でルールを選び、未インストールのワーカーはスキップします。
- 同じ種類の作業で合格率が低いワーカー（サンプル3件以上、40%未満）は自動的に後ろへ回されます。
- 差し戻し・交代時は、配置順で次のワーカーが投入されます。リードは`--executor`でいつでも直接指定できます。
- 配置表は実測値ではなく出発点であり、`hyperfusion.config.json`の`routing.rules`で変更できます。詳細は[routing](references/routing.md)を参照してください。
- Grokの画像生成は公開資料で言及されていますが、公式ドキュメントでは確認できていません。結果ファイルはスナップショット差分で検証されるため、アセットが実際に範囲内に生成されなければ合格になりません。

## 記憶層：AnchorMindの設計を取り入れた内蔵作業メモリ（v0.7）

[AnchorMind](https://github.com/jinho-von-choi/memento-mcp)に接続するのではなく、その設計をベンチマークしてHyperFusion内に直接実装しました。外部サーバーやDBを使わず、`~/.hyperfusion/memory/<workspace>.json`に保存します。ワーカーがセッションを開き直すたびに途切れていた試行錯誤（「このエラーは前に解決した」「ここではこう検証した」）を、次のセッションや別のワーカーに引き継ぐ共有経験層です。Drive（設計の正本）、Git（実装）、Notion（管理）の構成には手を加えません。

| 取り入れたアイデア | 実装 |
|---|---|
| 7種類のfragment、workspace分離 | 1〜2文（400字）単位、プロジェクトごとのファイル。書き込みごとにロック＋原子的保存 |
| 重複マージ | 同じ種類・類似度0.8以上・数値とバージョンが同一 → マージ（重要度↑、出典を蓄積、verified優先） |
| 矛盾検出＋レビュー待ち | 主題が重なるのに否定語や数値・バージョンが異なれば`needs_review`。リードが`resolve`するまでワーカーには渡さない。却下された内容は再保存されない |
| 重要度の減衰・再固定化・TTL | 種類別の半減期、再利用されると減衰がリセット、`ttl_days`で期限切れ。`reflect`が期限切れや忘れられた推定記憶をアーカイブへ移動 |
| 連想の拡散 | 上位結果とリンクされた記憶や同じ作業から出た記憶を、低いスコアで併せて取り出す |
| 検索 | BM25系の語彙スコア × 減衰後の重要度 × 信頼度。ハングルは文字bigramで索引化 |

| 経路 | 動作 |
|---|---|
| 読み込み | リードが`memory.mjs recall`で見つけた記憶をSOT・Gitと照合したうえで、briefの`prior_experience`として渡す。ワーカーには「brief・リポジトリより優先度が低く、確認してから使用」と伝える |
| 書き込み候補 | ワーカー結果の`memory_candidates`（最大3件）＋作業終了時にレビュー記録から自動抽出した「失敗 → 原因 → 修正 → 検証」 |
| 書き込み確定 | リードが`memory.mjs commit`で承認したものだけを保存。検証を通過した作業からプロトコルが抽出したものだけが`verified`、それ以外は`inferred` |
| ブロック | ワーカーからのdecision/preference/relationの提案、400字超過、秘密情報パターン、許可リスト外のanchor、workspace未設定（機能オフ） |

- **ワーカーが直接書き込まない理由：** 最初に誤って保存された記憶は、ストア自身では除去できません。そのため、書き込みも読み込みもリードを経由します。
- **検索の限界：** 埋め込みを使っていないため、意味は同じでも単語が異なる記憶は取りこぼす可能性があります。キーワードで補います。

詳細は[memory](references/memory.md)を参照してください。

## Orca・Paseoから取り入れたもの（v0.5）

[Orca](https://github.com/stablyai/orca)と[Paseo](https://github.com/getpaseo/paseo)をベンチマークしました。どちらも複数のコーディングエージェントを一か所で扱うアプリ/デーモンです。そのうち、本スキルの単一writer・監査構造に合うものだけを取り入れています。

| 機能 | 出典 | 内容 |
|---|---|---|
| advisor | Paseo `/paseo-advisor` | 別のワーカーが読み取り専用でdiffを事前チェックし、findings（ファイル・行・深刻度）を出す。Opusはそれを手がかりに検収し、読む量を減らす |
| committee | Paseo `/paseo-committee` | 異なるワーカー2者が並列で根本原因と実行計画を出す。同じミスが繰り返されると状態に推奨（`hint`）が付く |
| 行単位のフィードバック | Orca diff annotate | `lead_feedback`に`{file, line, comment}`。相談のfindingsをそのまま渡せる |
| 通知 | 両方 | `HF_NOTIFY_URL`（例：ntfy）で、ワーカー完了・相談完了・リードの判断が必要な時にスマートフォンへプッシュ |

相談はwriter leaseなしで動作し、実装予算を消費しません（作業あたり委員の実行は4回まで）。読み取り専用は、CLI設定（Sonnetは読み取りツールのみ、agy `--mode plan`、Grokは編集・シェルをdeny）に加えて、**相談前後のスナップショット比較**で保証します。ツリーに触れた相談は回答を破棄して復旧へ移り、そのワーカーはrouterの実績が下がります。詳細は[consult](references/consult.md)を参照してください。

**取り入れなかったもの**
- **Orcaのworktree競争（同じbriefを複数ワーカーに同時に与えて勝者を採用）：** 最も魅力的な機能ですが、単一作業ツリーという中核の不変条件を変える必要があります。依存関係のインストールやWindowsのシンボリックリンクの問題もあり、次の段階に見送りました。
- **作業DAG：** 次の段階に見送りました。
- **モバイルアプリ・音声・内蔵ブラウザ・リモート接続：** スキルの範囲外です。

## v0.3からの変更点

| 機能 | 状態 |
|---|---|
| リード | Claude Opus 5.5（`claude-opus-5-5`）、Claude Codeホスト |
| Grokアダプター | 実装済み。`--prompt-file`、`--output-format json`、`--session-id`/`--resume`、scopeベースの`--allow Edit(...)`、git変更コマンドの`--deny` |
| Antigravityアダプター | 実装済み。`--json-schema`による構造化出力、CLI発行の`conversation_id`で再開、デフォルト`--sandbox` |
| Sonnetアダプター（v0.4） | 実装済み。Claude Code `-p --model claude-sonnet-5-5`、`--json-schema`、`--safe-mode`、`dontAsk` |
| 自動ルーティング（v0.4） | 実装済み。配置表＋実績＋インストール状況 |
| ワーカー予算 | ワーカーあたり3ラウンド（v0.2.1は2）、リードのtakeoverは1回 |
| takeover条件 | すべてのワーカーを使い切った場合のみ。それまではコントローラーが拒否 |
| 空の差し戻し禁止 | 差し戻しに`blocking_criteria`必須、再指示に`lead_feedback`必須 |
| 自動交代 | 同じ差し戻し理由が2回連続すると別ワーカーへ強制交代 |
| Luna | 削除。Claudeワーカーは`sonnet`としてのみ起用（リードのOpusとは別プロセス） |
| 実際のGrok/agy/Sonnetの認証・モデル呼び出し | 本パッケージのテストでは検証していない |

CLIフラグは、xAIの[Grok Build headlessドキュメント](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)、[Antigravity CLI headlessドキュメント](https://antigravity.google/docs/cli/headless)、[Claude Code headlessドキュメント](https://code.claude.com/docs/en/headless)に基づいています。インストール済みのバージョンに必要なフラグがなければpreflightで拒否し、フラグを弱めて回避することはしません。

## インストールと使い方

Node.js 20以上、Git、初期コミットのある対象リポジトリ（Linux・macOS・Windows）、そしてインストール・認証済みの`grok`、`agy`、`claude`のうち1つ以上が必要です。

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Windowsではnpmの`.cmd`ラッパーを自動的に解決して実行し、プロセスの後始末は`taskkill /T`で行います。ワーカーが先に終了した後に残った子孫プロセスは自動では捕捉できないため、リードが確認する必要があります。また、agyがTTYなしで停止する既知の問題があるため、`executors.antigravity.timeout_ms`を短めに設定することを推奨します。詳細は[ワーカーランタイムのWindowsの節](references/executor-runtime.md#windows)を参照してください。

Claude Code（Opus 5.5を選択）で：

```text
/hyperfusion <作業内容>
/hyperfusion --executor sonnet <作業内容>
```

単独で動くコマンドやデーモンはありません。リードが`SKILL.md`に従ってbriefを書き、コントローラーとブリッジを呼び出します。デフォルトのワーカーとポリシーは対象リポジトリの`hyperfusion.config.json`で設定します（例：`hyperfusion.config.example.json`）。実行ファイルのパスは`HF_GROK_BIN`、`HF_AGY_BIN`、`HF_CLAUDE_BIN`で変更できます。

詳しい手順：[SKILL.md](SKILL.md)、[runtime](references/runtime.md)、[ワーカーランタイム](references/executor-runtime.md)、[配置](references/routing.md)

## テスト

```sh
npm test
```

121件のテストで、次の項目を確認しています。

- レビュー委任：Codex優先の割り当て、自己レビューの禁止、判定の自動適用・保留・採用・上書きの記録、`@review`による指示の受け渡し、レビュアー失敗時の交代とラウンド上限、形式誤りの判定の破棄、未完了ラウンドのpass阻止、読み取り専用違反の破棄、takeoverコードのレビュー、Codexの実装禁止と設定検証
- 記憶層：秘密情報・サイズ・権限のブロック、候補台帳、プロトコルによる自動抽出、リード承認による保存、verified/inferred、重複マージ、矛盾のレビュー待ち、減衰・再固定化・TTL、連想の拡散、ハングル検索、workspace分離、ファイルロック
- 相談：advisor/committeeの実行、読み取り専用違反の検出、相談中のロック、予算
- 行単位のフィードバック、通知の送信
- Windowsのパス処理：`.cmd`ラッパーの解決、`.js`エントリーポイント、バックスラッシュのパス、コマンドライン長
- Grok/Antigravity/Sonnetの正常実行、作業別の配置・インストール状況の反映・実績に基づく降格・交代順序
- セッション再開、重複実行のブロック、エラー・timeout・出力上限・結果検証
- 空の差し戻しの拒否、同じミスの繰り返しによる交代、ワーカーが残っている間のtakeover拒否、予算を使い切った後の1回限りのtakeover
- 虚偽の変更報告の検出、リード/ワーカーの使用量の分離集計

GitHub ActionsでUbuntu・Windows × Node 20・24の組み合わせで実行しています。テスト内の`grok`/`agy`/`claude`/`codex`は明示的にスタブであることを示しており、実際のモデルは呼び出しません。

## 完了報告の診断

対象リポジトリの`.fusion/tasks/<task_id>/`：

- `dispatch-N.json`：ワーカー、CLI引数、セッション
- `envelope-N.json`：終了コード、中断理由、元のstdout/stderr
- `result-N.json`、`session-N.json`、`usage-N.json`：検証済みの結果、セッションID、ワーカーが報告した使用量
- `review-N.json`：リードの判定と差し戻し理由
- `.fusion/state.json`：段階、配置結果とその根拠（`routing`）、ワーカーごとの残り予算、交代履歴
- `.fusion/metrics/<task_id>.json`：routerが学習する作業ごとの記録

## 運用原則

writerは1者のみです。lockは協調のための統制であり、OSのサンドボックスではありません。自動commit/push/deploy/release、範囲の拡大、破壊的な復旧は行いません。

目標指標は**成功した作業あたりのOpusリードのトークン数**です。失敗した作業も分子に含めます。ワーカーのコストと所要時間は別のガードレールとして記録します（Antigravityはコストを報告しないためnull）。作業が終わるたびに`metrics.mjs`を実行することで、routerが実績を学習します。計測されていない値はnullです。

実行ログ・セッション・認証情報は本リポジトリに含めていません。`.fusion/`は対象リポジトリ内の非公開のローカル作業記録です。
