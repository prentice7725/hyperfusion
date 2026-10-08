# HyperFusion

[한국어](README.md) | 日本語

**Claude Opus 5.5は指示と検収だけを行い、コードは他のモデルが書きます。** 実装とテストをSonnet・Grok・Antigravity・Lunaに任せ、レビューはSolに任せることもできるClaude Codeスキルです。

## 作った理由

1. **トークン節約。** 高価なモデル（Opus）がコードを書き、テストを回し、ログを読むのにトークンを使うのは無駄です。Opusは計画・差し戻し・最終検収だけを行い、実装とテストの反復はより安いモデルや別サブスクリプションのモデルが担当します。成功した作業あたりのOpusトークンを主要指標として計測し記録します。
2. **相手にするのはリードだけ。** 複数のエージェントを一画面で管理するツールはすでにあります。このスキルは逆に、ユーザーが**Opus一人だけを相手にし、ワーカーの管理はOpusが行います。** ワーカーの「完了しました」は信用せず、空の差し戻しは許さず、具体的な指示書で詰め、同じミスを2回したら別のワーカーに交代させます。

## チーム

| メンバー | モデル | 基本の役割 |
|---|---|---|
| **Opus（リード）** | claude-opus-5-5 | チーム編成、計画、差し戻し、最終検収。ワーカーが残っている限りコードは書かない |
| Sonnet | claude-sonnet-5-5 | 中・高難度のコード、テスト、リファクタ |
| Grok | Grok CLI | 画像アセット、易しい実装 |
| Antigravity | agy | UI・フロントエンド、ドキュメント（画像生成機能なし） |
| Luna | gpt-6-luna（Codex） | 小規模な修正、機械的な大量編集、画像アセットの補助 |
| Sol | gpt-6.1-sol（Codex） | レビュー・委員会相談専任。コードは書かない |

基本の配置は出発点です。プロジェクトごとにリードが変更し、種類・難易度別の実績に時間減衰と再探索を適用して配置を調整します。未インストールのワーカーは飛ばされます。実行前のCLI確認が一時的に失敗しても試行予算を消費せず再試行できます。担当ワーカーの実行ファイルがなくなった場合は別のワーカーに交代できます。

## 特徴

- **チーム編成 → 承認 → マイルストーン → チェックポイント。** 企画書を読んだリードが担当を決めたチームを報告し、承認前は作業が始まりません。マイルストーンが終わると報告し、確認を受けてから次へ進みます。→ [project](references/project.md)
- **能動的な配置。** 作業の種類（コード、UI、画像、テスト…）と難易度、過去の実績、インストール状況でワーカーを選びます。→ [routing](references/routing.md)
- **ワーカーの言葉は信用しない。** 変更ファイルやテスト合格の主張は、スナップショットdiffとリードの再実行でのみ認めます。虚偽の申告は復旧段階に回されます。
- **厳格な差し戻し。** 差し戻しには理由が必須で、再指示にはファイル・行単位の指示書が必須です。同じ理由で2回差し戻されたらワーカーを交代します。ワーカーあたり3ラウンド、リードのtakeoverは全ワーカーが尽きた後の1回だけです。
- **レビュー委任。** ラウンドのレビューをSolなど別のモデルが読み取り専用で行い、判定を適用します。Opusがdiffを精読するトークンを節約できます。実装したモデルは自分のレビューができません。→ [review](references/review-protocol.md)
- **相談。** ワーカー1人（advisor）が先にdiffを検査するか、2人（committee）が繰り返す失敗の原因を分析します。読み取り専用で、相談前後のスナップショットで保証します。→ [consult](references/consult.md)
- **内蔵の記憶層。** 試行錯誤（エラー、手順、経験）を外部サーバーなしでローカルに蓄積し、次のセッションや他のワーカーに引き継ぎます。書き込みも読み取りもリードの承認を通り、秘密値は保存しません。→ [memory](references/memory.md)
- **単一writerと監査記録。** 同時に書くのは一人だけで、ラウンドごとにスナップショットと成果物が残ります。中断しても復旧手順で再開できます。自動のcommit・push・デプロイはありません。
- **リードの入力削減。** 結果ファイルの自動読み込み、briefの既定値、stdin入力、要約statusを利用できます。ラウンドのタイムラインとリポジトリ全体の指標も一つのコマンドで確認できます。→ [運用コマンド（韓国語）](references/operations.md)
- **独立worktreeと作業上限。** 作業ごとに状態とwriter leaseを分離して並列実行し、報告された費用と経過時間に上限を設けます。結果は個別に検収してから統合します。→ [並列実行・上限（韓国語）](references/operations.md)
- **通知。** `HF_NOTIFY_URL`（例：ntfy）で、ワーカーの完了やリードの判断が必要な時にスマホへプッシュ通知を受け取れます。本文は状態だけです。
- **Linux・macOS・Windows対応。**

## セキュリティ

ワーカーがユーザーのファイルを勝手に触れないよう、何層かで防ぎます。ただしこれは**協調的な統制であり、OSのサンドボックスではありません。**

- 制御ファイル（状態、brief、スナップショット）は作業フォルダの外`~/.hyperfusion/state/`に置きます（`HF_STATE_DIR`で変更）。ワーカーが自分で範囲を広げることはできません。
- スナップショットは`.git`の設定・フック、`.env`、無視された`.gitignore`、`node_modules/.bin`まで見ます。コントローラのgitは、リポジトリ設定でコードが実行されないよう呼び出します。
- ブリッジは実行直前にリクエストを再生成して照合します。ワーカーには必要な環境変数だけを渡します。
- Bashの許可ルールはテスト・lint・ビルドの形だけを受け付けます。サンドボックス解除などの緩和は、リポジトリ設定ではなくオペレーターの環境変数でのみ有効にします。

シェルを使えるワーカーは作業フォルダ外のファイルに触れ得ます。CodexとAntigravityはそれぞれのサンドボックスに依存します。既に無視されている通常の依存ファイル（例：`node_modules/dep/index.js`）の内容変更はスナップショットで監視しません。コントローラが受け入れテストを直接実行する際は、無視されたファイルのメタデータを比較し、変化があれば実行しません（[operations](references/operations.md#수용-테스트-자동-실행)）。旧バージョンから更新した場合は`fusion-state.mjs migrate <リポジトリ>`を一度実行してください。詳細は[configuration](references/configuration.md)、[recovery](references/recovery-protocol.md)。

## インストールと使い方

必要なもの：Node.js 20+、Git、**初期コミットのあるGitリポジトリ**（リモートなしのローカル専用でも可）、インストール・認証済みの`claude`、`grok`、`agy`、`codex`のうち1つ以上。

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Claude CodeでOpus 5.5を選び：

```text
/hyperfusion <作業内容>
/hyperfusion --executor sonnet <作業内容>
```

リードが[SKILL.md](SKILL.md)に従ってコントローラとブリッジを呼び出します。まず`node scripts/setup-doctor.mjs <リポジトリ>`でインストール状況を点検してください。設定は対象リポジトリの`hyperfusion.config.json`（例：`hyperfusion.config.example.json`）です。

初期化済みの作業は`node scripts/fusion-state.mjs autopilot <リポジトリ>`でラウンド実行と独立した委任レビューを自動進行できます。リードが承認した`acceptance_commands`と`review.auto_apply:true`が必要です。VERIFY・設計判断・BLOCKED・takeoverではリードに制御を返し、プロセス停止・スナップショット・予算・検証の確認に失敗した場合も停止します。最終verifyはリードが担当します（[運用説明（韓国語）](references/operations.md#오토파일럿)）。

外部に送るbrief・diff・過去の結果には、メール・IP・キー・パスワードのパターンマスキングを標準適用します。認証に必要なベンダー環境変数は維持します。CLIが直接読み取って送るリポジトリの内容まで保護するDLPではないため、社内コードではファイルアクセスと外部送信の方針も別途管理してください（[送信範囲（韓国語）](references/operations.md#외부-전송-마스킹)）。

ドキュメント：[runtime](references/runtime.md) · [ワーカーランタイム（Windows含む）](references/executor-runtime.md) · [configuration](references/configuration.md) · [state-schema](references/state-schema.json)

## テストと制約

```sh
npm test
```

自動テストが、状態機械、ワーカーアダプタ、配置、レビュー委任、記憶層、プロジェクトの流れ、セキュリティ、マスキングとオートパイロットを確認します。実際のCLIを使うスモーク1件は`HF_LIVE=1`の時だけ実行します。GitHub ActionsはUbuntu・Windows × Node 20・24で実行する構成です。再監査後の修正と残る制約は[修正結果の報告書（韓国語）](references/reaudit-v0.10.0.md)にまとめています。

**テストの`grok`/`agy`/`claude`/`codex`は代役のCLIです。** 実際のモデル呼び出し、認証、画像生成は、このリポジトリのテストでは検証されていません。インストール済みCLIに必要なフラグがない場合は、実行前に`ADAPTER_UNAVAILABLE`で拒否します。CLIフラグは[Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)、[Antigravity CLI](https://antigravity.google/docs/cli/headless)、[Claude Code](https://code.claude.com/docs/en/headless)のドキュメントを基準にしています。

バージョン履歴は[CHANGELOG（韓国語）](CHANGELOG.md)、ライセンスは[MIT](LICENSE)。

## 参考にしたもの

- [Orca](https://github.com/stablyai/orca)、[Paseo](https://github.com/getpaseo/paseo)：advisor/committee、行単位のフィードバック、通知。worktree競争は単一作業ツリーの原則と合わないため取り入れていません。
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp)：記憶層の設計（重複統合、矛盾レビュー、減衰、出典表示）。接続はせず、設計だけを取り入れて自前で実装しました。
