# HyperFusion

[English](README.md) | [한국어](README.ko.md) | 日本語

**Claude Opus 5.5は指示と検収だけを行い、コードは他のモデルが書きます。** 実装とテストをSonnet・Haiku・Grok・Antigravity・Lunaに任せ、レビューはSolに任せることもできるClaude Codeスキルです。

> **バージョン。** パッケージのリリースは`0.29.0`（`package.json`）です。**v0.3**はその上に載せた運用プロファイル（External-First＋共通監視）の名前で、保存スキーマ4、アーキテクチャ識別子`opus-lead-v0.3`、wire protocol `hyperfusion-opus-lead-v0.5`はパッケージバージョンとは別の互換性識別子です（正本は`scripts/versions.mjs`）。バージョンごとの変更は[CHANGELOG（韓国語）](CHANGELOG.md)を参照してください。

## 最近の変更

**0.30.0**

- **Codex・Antigravity のリード(C 等級)。** Claude Code だけでなく、Codex CLI や agy のセッションもリードになれます。`node scripts/lead-guard.mjs --print-settings --host codex|antigravity` がフック設定を出力します。リードのモデルはホストのフックか `HF_LEAD_MODEL` から決まり、根拠がなければ init は `LEAD_MODEL_UNKNOWN` で拒否します。Claude 以外のリードには `review.strategy: "lead-gated-adaptive"` が必要です。Windows で一部を実測しました。→ [Codex](references/hosts/codex.md)、[Antigravity](references/hosts/antigravity.md)
- **役割はリードのモデル系列に従う。** 実装者・専門家・レビュー枠をリードのモデルから計算します(Claude 以外のリードは `family-rules-v1`)。Opus リードの動作は変わりません。
- **実測で見つかったレビュー・受け入れの問題を修正。** agy は結果スキーマをファイルで受け取り、それでも Windows のコマンドラインに収まらないときは短くすべきフィールドを示します。`detail` で書かれた Grok の指摘を受け付けます。契約の訂正がレビュアーに届きます。ワーカーが blocked と報告してもコントローラが受け入れコマンドを実行します(承認の拒否は変わりません)。レビュアーのターン上限を別に設定できます(`consult_max_turns`)。

**0.29.0**

- **レビュアーに結論を渡さない。** 委任レビュアーは、ワーカーの要約・テスト合格の報告・リスク評価や、以前のレビュアーの判定・理由を受け取りません。diff、ファイル、コントローラが自分で実行した受け入れ結果だけで判断します。→ [review（韓国語）](references/review-protocol.md)
- **リードの指摘ごとの処分。** `lead-decision`で指摘ごとに`act`・`consider`・`noted`・`dismissed`・`contract_misread`と理由を残します。却下した指摘は次のワーカーに渡らず、指標がレビュアーごとの実効性（`actionable_rate`）を数えます。→ [review（韓国語）](references/review-protocol.md#지적별-처분-finding_dispositions-선택)

## 作った理由

1. **トークン節約。** 高価なモデル（Opus）がコードを書き、テストを回し、ログを読むのにトークンを使うのは無駄です。Opusは計画・差し戻し・最終検収だけを行い、実装とテストの反復はより安いモデルや別サブスクリプションのモデルが担当します。成功した作業あたりのOpusトークンを主要指標として計測し記録します。
2. **相手にするのはリードだけ。** 複数のエージェントを一画面で管理するツールはすでにあります。このスキルは逆に、ユーザーが**Opus一人だけを相手にし、ワーカーの管理はOpusが行います。** ワーカーの「完了しました」は信用せず、空の差し戻しは許さず、具体的な指示書で詰め、同じミスを2回したら別のワーカーに交代させます。

## チーム

| メンバー | モデル | 基本の役割 |
|---|---|---|
| **Opus（リード）** | claude-opus-5-5 | チーム編成、計画、差し戻し、最終検収。ワーカーが残っている限りコードは書かない |
| Sonnet | claude-sonnet-5-5 | 中・高難度のコード、テスト、リファクタ |
| Haiku | claude-haiku-5-5 | 易しいコード、ドキュメント、テスト補強（Sonnetと同じClaude Code CLI） |
| Grok | Grok CLI | 画像アセット、易しい実装 |
| Antigravity | agy | UI・フロントエンド、ドキュメント（画像生成機能なし） |
| Luna | gpt-6-luna（Codex） | 小規模な修正、機械的な大量編集、画像アセットの補助 |
| Sol | gpt-6.1-sol（Codex） | 通常はレビュー・委員会相談。v0.3のAPEX承認ラウンドでのみ実装可能 |

基本の配置は出発点です。プロジェクトごとにリードが変更し、種類・難易度別の実績に時間減衰と再探索を適用して配置を調整します。未インストールのワーカーは飛ばされます。実行前のCLI確認が一時的に失敗しても試行予算を消費せず再試行でき、担当ワーカーの実行ファイルがなくなった場合は別のワーカーに交代できます。モデルIDは設定の既定値で、実際のCLI・アカウントでの利用可否は別途確認してください。

## 一つの作業の流れ

```text
リード: 計画（brief＋受け入れコマンド）→ init → begin
ワーカー: 単一writerとして実装 → 結果を報告
コントローラ: finish（スナップショットdiff、受け入れテストの直接実行、プロセス停止の確認）
レビュー: 実装していない別のモデルが、ワーカーの主張なしに読み取り専用で検討
リード: 指摘ごとの処分＋判定（pass / redo / alternative / decision / takeover）→ verify → CLOSE
```

CLOSEまで到達して初めて成功です。どの段階でも、次に打つコマンドは`node scripts/fusion-state.mjs next <リポジトリ>`が教えてくれます。

## 特徴

**配置とチーム**

- **チーム編成 → 承認 → マイルストーン → チェックポイント。** 企画書を読んだリードが担当を決めたチームを報告し、承認前は作業が始まりません。`project.mjs draft`がインストール済みのメンバーで案を埋め、未導入のメンバーは拒否します。マイルストーンが終わると報告し、確認を受けてから次へ進みます。`project.mjs schedule`はタスクの依存関係を固定計画として管理します（実装は直列）。→ [project](references/project.md) · [作業計画](references/workflow-plan.md)
- **能力ベースの配置。** 名前ではなく能力（`caps`：code、ui、docs、image-gen…）で候補を絞り、自分のリポジトリでの実績（差し戻し率）で順番を決めます。実績のない新人にはときどき先に任せます。既存アダプターのモデルID・能力は設定で変更でき、新しい提供元には別途アダプターの実装が必要です。→ [routing](references/routing.md)
- **導入状況の点検と契約スモーク。** `setup-doctor.mjs`は設定を変えずに、インストール済みCLIに合うプリセットを推薦します。`--smoke`はワーカーごとに一時リポジトリで小さな作業を実際に任せ、CLIフラグ・出力形式・結果契約が合っているか確かめます。導入確認は認証や残量の検証ではありません。→ [operations](references/operations.md#doctor-계약-스모크)

**ワーカーを信用せず確認する**

- **ワーカーの言葉は信用しない。** 変更ファイルやテスト合格の主張は、スナップショットdiffとコントローラの再実行でのみ認めます。虚偽の申告は復旧段階に回されます。
- **厳格な差し戻し。** 差し戻しには理由が必須で、再指示にはファイル・行単位の指示書が必須です。同じ受け入れ基準（AC1…）で2回差し戻されたらワーカーを交代します。ワーカーあたり3ラウンド、リードのtakeoverは全ワーカーが尽きた後の1回だけです。
- **red-firstの受け入れテスト。** コントローラが受け入れコマンドを自分で実行します。開始時に手を付けていないツリーで失敗することを先に確かめ、最初から通ってしまう見せかけの関門を防ぎます。リファクタのように最初から通るのが正しい作業には**保存検証**（`verification:{kind:"preserve",protect:[...]}`）を使い、テストやフィクスチャが作業中に一度も変わっていないことをコントローラがスナップショットで証明します。
- **AC追跡表とPR下書き。** `acceptance_map`で受け入れ基準（AC1…）とそれを証明するコマンドを結びます。完了時にAC別の判定表とPR説明の下書き（`pr-draft.md`）を残します。変更一覧は最初のワーカー開始時（`base-1`）からの最終的な累積差分で、ワーカーラウンドに帰属しないファイルは`unattributed_changes`として別に表示します。コミット・プッシュはユーザーが指示します。
- **独立したレビュー委任。** ラウンドのレビューをSolなど別のモデルが読み取り専用で行います。レビュアーには累積diff（最大100,000文字）とコントローラが実行した受け入れ結果が渡り、ワーカーの要約・テスト報告や以前のレビュアーの結論は渡りません。実装したモデルは自分のレビューができません。根拠（ファイル・行）のない差し戻しはそのまま適用されません。→ [review](references/review-protocol.md)
- **指摘台帳とリードの処分。** レビューの指摘を原証拠とともに集め（`findings`）、リードが指摘ごとに処分と理由を残します。次のラウンドには`@findings`で受け入れた指摘だけを渡し、処分の記録はレビュアーごとの実効性の指標になります。表示をまとめても原証拠と必須レビューは維持されます。→ [指摘台帳](references/finding-ledger.md)
- **相談。** ワーカー1人（advisor）が先にdiffを検査するか、2人（committee）が繰り返す失敗の原因を分析します。読み取り専用で、相談前後のスナップショットで保証します（同時に最大2スロット）。→ [consult](references/consult.md) · [読み取り専用作業](references/read-only-work.md)
- **ラウンド間の変更もレビュー。** 後続の`begin`は現在のツリーと直前の`post_digest`を比較します。スコープ内のファイルをBashで書いた場合も、不一致ならleaseや試行予算を消費する前に`RECOVERY_REQUIRED`で停止します。復旧で保持した変更は累積レビューの対象になりますが、ワーカーの実績や自動承認とはしません。最初の`begin`前にあったユーザー変更は保持します。→ [recovery](references/recovery-protocol.md)

**リードの負担を減らす**

- **短い出力と`next`。** コマンドラインの出力は既定でcompact表示です（全体は`--full`）。`next`は今の段階で打つコマンド1行と、tokenやdigestのようにコントローラが知っている値をあらかじめ埋めた入力の雛形を返します。
- **診断と再開。** 読み取り専用の`diagnose`が停止理由を固定コードで、`resume`が中断した作業の次の手順を示します。精算（`reconcile`）はinitで許可した場合だけ明示的に実行します。→ [再開・精算](references/reconciliation.md)
- **裁量権（オプトイン）。** リードがinitで作業単位に`delegation`を与えると、コントローラが条件をすべて確認できた場合にSTANDARDラウンドを承認し（`delegated-policy`として記録）、一時障害で結果なしに終わったワーカー実行を再試行し、終えられなかったレビュアーを別の会社のモデルに差し替えます。条件が一つでも足りなければリードゲートで止まります。→ [universal-supervisor（韓国語）](references/universal-supervisor.md#위임-승인-재량권)
- **オートパイロット。** `autopilot`がラウンド実行と独立した委任レビューを自動で進めます（下の[インストールと使い方](#インストールと使い方)）。`report`の`lead_load`は、リードが自分で下した判定の数、コントローラが承認した数、リードが読む必要があったゲートの数、自動・手動の復旧の数を示します。
- **要約の後も続けられる。** リードガードのSessionStartフックが、会話が要約されたときや新しいセッションの開始時に、進行中の作業と次のコマンドを一度だけ知らせます。
- **作業状態の一行。** `fusion-state.mjs line`、UserPromptSubmitフック、プロンプト上のバンドモッド（`mods/hf-status`）が、同じ一行でフェーズ・ワーカーのラウンド・次の操作を表示します。→ [運用説明](references/operations.md#작업-상태-표시)
- **内蔵の記憶層。** 試行錯誤（エラー、手順、経験）を外部サーバーなしでローカルに蓄積し、次のセッションや他のワーカーに引き継ぎます。書き込みも読み取りもリードの承認を通り、出典・バージョンで絞り込みます。秘密値は保存しません。→ [memory](references/memory.md) · [メモリ検索](references/memory-recall.md)
- **通知。** `HF_NOTIFY_URL`（例：ntfy）で、ワーカーの完了やリードの判断が必要な時にスマホへプッシュ通知を受け取れます。本文は状態だけです。

**安全と監査**

- **単一writerと監査記録。** 同時に書くのは一人だけで、ラウンドごとにスナップショットと成果物が残ります。中断しても復旧手順で再開できます。自動のcommit・push・デプロイはありません。
- **リードガードフック。** leaseが掛かっている間やワーカーの予算が残っている間はリードのEdit/Writeと書き込み可能なMCPツールをブロックし（PreToolUse）、リードの番の作業を残したままターンを終えようとすると一度止めます（Stop）。Bashの書き込みはこのフックではなく、スナップショットとラウンド間のdrift検査が確認します。→ [operations（韓国語）](references/operations.md#리드-가드-훅)
- **独立worktreeと作業上限。** 作業ごとに状態とwriter leaseを分離し、報告された費用と経過時間に上限を設けます。結果は個別に検収してから統合します。→ [並列実行・上限（韓国語）](references/operations.md)
- **Linux・macOS・Windows対応。**

## v0.3: External-Firstと共通監視（オプトイン）

`hyperfusion.v03.config.example.json`を対象リポジトリの`hyperfusion.config.json`にコピーして明示的に有効化します。既存のclassic設定と実行中のタスクは自動変更されません。詳細は[universal-supervisor](references/universal-supervisor.md)（韓国語）を参照してください。

- **External-First配置。** 自動実装はGrok・Antigravity・Lunaが担当します。Sonnet（重要/再割り当てラウンド）とSol（APEXラウンド）はラウンドごとのgrantがある場合のみ実装し、自動フォールバックや新人優遇はこの2つを選びません。
- **作者別のレビュー。** 通常作業は独立レビュアー1名、重要・明示的な二重レビュー・リスクパスは下表のペアが独立・並列に検証します。実装者の自己レビューは禁止です。差し替えには理由が必要で、既存のNGは別のPASSで消えません。不一致・欠落はリード判断に残します。以前の割り当てと承認済みのGrokなしチームは従来の規則を維持します。
- **最終リードゲート。** 結果は`LEAD_DECISION_REQUIRED`で止まります。`auto_apply`、レビュー採用、オートパイロットでは飛ばせず、作業単位の裁量権だけがポリシー承認を許可します。
- **共通ローカル監視。** すべてのimplement/review/consult呼び出しを同じsupervisorが観測します（`status --monitor`、`monitor --once|--watch`）。無信号はQUIET警告にとどまり、進捗や成功を生成しません。監視でモデルは呼びません。
- **使用量の計測とクォータ。** 実装・レビュー・相談・失敗呼び出しとAPEX Solを含めて記録し、未計測は`null`のままにします。クォータは`scripts/quota-policy.mjs`で、運用者が直接書き込む（`record`）か、Codexのセッション記録の`rate_limits`を読んで記録します（`collect-codex`、ネットワークもモデルも使いません）。出所と有効期限が過ぎた記録は「不明」として扱います。
- **既定の推論強度。** Sonnet high、Haiku max、Antigravity high、Grok medium、Luna xhigh、Sol medium。Grokの実装・通常の相談は明示設定がなければmedium、指定されたadaptiveペアレビュー席だけxhighです。`reasoning_effort:null`は通常フラグの省略で、必須レビュー役割の強度は解除しません。

| 実装者 | 重要・二重・リスクパスのレビューペア |
|---|---|
| Grok medium | Sol medium + Sonnet high |
| Luna | Sonnet high + Grok xhigh |
| AGY / Haiku / 承認済みSonnet | Sol medium + Grok xhigh |
| 承認済みAPEX Sol | ペア委任ではなくリードの直接レビュー |

リードはinitの承認済み指示書で重要度・戦略を決め、`review_preview`を確認します。根拠のある全員NGだけがinitで付与された`redo_delegation`で再作業に戻り、意見の不一致はリードが判断します。全員PASSも別途適格な承認委任がなければリードに報告します。ホストが本当にOpusかは認証できないため、`authority.model_verified:false`として記録します。→ [詳細](references/review-pairs.md)

## ベンダー・モデル設定

- **AGYモデル系統とeffort。** `executors.antigravity.model:"gemini-4-argon"`と`reasoning_effort:"high"`を別々に設定すると`gemini-4-argon-high`を選びます。接尾辞で固定したモデルはその強度を維持し、矛盾するeffortは起動前に拒否します。最終slugを`agy models`で確認し、利用できない組み合わせを別モデルに置き換えません。→ [設定案内](references/configuration.md#agy-모델-계열과-effort-분리-argon)
- **Codex。** JSONL thread・turn使用量を記録し、互換性のある`exec resume`フラグを確認できた場合だけ、タスク内の実装セッションを正確なIDで再開します。レビューは毎回新しい読み取り専用セッションです。運用者専用のビルドキャッシュ・ネットワーク設定とClaude/Grokのターン上限は[Codex運用案内](references/codex-runtime.md)を参照してください。
- **ベンダー制限。** `allowed_vendors:["anthropic","openai"]`は実装・レビュー・相談をまとめて制限し、運用者の`HF_ALLOWED_VENDORS`はリポジトリ側で広げられない上限です。ブリッジも起動直前に再検査します。ファイアウォール・DLPやベンダー認証ではありません。新CLIには検証済みアダプターが必要です（`scripts/member-registry.mjs`）。

## 測定

- **リードの使用量。** 生成したフックがStop/SessionEnd/StopFailure時にローカルClaude Code transcriptから実際のモデルごとの使用量を収集します。証拠がなければ未測定とし、明示的な`TASK_USAGE.json`の観測を優先します。クライアントの報告値であり、課金APIではありません。→ [指標ポリシー](references/metrics-policy.md)
- **ベンチマーク。** `benchmark.mjs cases`は固定パイロット課題を、`compare BASELINE.json HYPERFUSION.json`は実測のペア指標を比較します。失敗のコストも分子に入れ、ペア欠落・未測定があれば削減率を出しません。実モデルのパイロットは未実施なので、削減効果は主張しません。→ [反復ベンチマーク](references/benchmark-pilot.md)

## セキュリティ

ワーカーがユーザーのファイルを勝手に触れないよう、何層かで防ぎます。ただしこれは**協調的な統制であり、OSのサンドボックスではありません。**

- 制御ファイル（状態、brief、スナップショット）は作業フォルダの外`~/.hyperfusion/state/`に置きます（`HF_STATE_DIR`で変更）。ワーカーが自分で範囲を広げることはできません。
- スナップショットは`.git`の設定・フック、リンクworktreeの専用`config.worktree`、`.env`、無視された`.gitignore`、`node_modules/.bin`、agyのworkspaceフォルダ(`.agents/`・`.agent/`・`_agents/`・`_agent/`)まで見ます。コントローラのgitは呼び出し直前にinclude・条件付きinclude・worktreeを含む実際の適用設定を読み直し、実行可能なドライバーを無効化します。設定を読めなければ`GIT_CONFIG_UNREADABLE`で停止します。
- ブリッジは実行直前にリクエストを再生成して照合します。ワーカーには必要な環境変数だけを渡します。
- Bashの許可ルールはテスト・lint・ビルドの形だけを受け付けます。サンドボックス解除などの緩和は、リポジトリ設定ではなくオペレーターの環境変数でのみ有効にします（[configuration](references/configuration.md#보안-관련-환경변수)）。
- 読み取り専用の相談・レビューは、ツールのサンドボックスではなく前後のスナップショット比較で保証します（破った回答は捨てます）。Antigravityの`--sandbox`はターミナルだけを制限し、ファイル書き込みツールは止められません。

シェルを使えるワーカーは作業フォルダ外のファイルに触れ得ますし、スナップショット比較はリポジトリの外への書き込みを捉えられません。既に無視されている通常の依存ファイル（例：`node_modules/dep/index.js`）の内容変更はスナップショットで監視しません。コントローラが受け入れテストを直接実行する際は、無視されたファイルのメタデータを比較し、変化があれば実行しません（[operations](references/operations.md#수용-테스트-자동-실행)）。旧方式で制御ファイルを作業フォルダ内に置いていた場合は`fusion-state.mjs migrate <リポジトリ>`で移行します。互換性のない保存スキーマには、文書のarchive手順を適用してください。詳細は[configuration](references/configuration.md)、[recovery](references/recovery-protocol.md)。

## インストールと使い方

必要なもの：Node.js 24+、`git config --show-scope --includes`をサポートするGit、**初期コミットのあるGitリポジトリ**（リモートなしのローカル専用でも可）、インストール・認証済みの`claude`、`grok`、`agy`、`codex`のうち1つ以上。

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

**リードガードフックの導入（推奨）。** `npm run guard:settings`が、このPCの絶対パスで書かれたフック設定（PreToolUse、Stop、SessionStart、UserPromptSubmit、PreModelSwitch、PostModelSwitch、SessionEnd、StopFailure）を出力します。ブロックするガードコマンドには`onFailure: "block"`（Claude Code v2.1.295以降）が付き、ガードが落ちたりタイムアウトしたりするとツール呼び出しがブロックされます。その`hooks`の項目を`~/.claude/settings.json`（または対象リポジトリの`.claude/settings.json`）にマージします。既存の導入でも各イベントの新しい使用量収集コマンド、MCPツールガード（`mcp__.*`）の項目、モデル切り替えの項目をマージしてください。他のフックを保持し、既存コマンドの重複を避けます。

**オートパイロット。** 初期化済みの作業は`node scripts/fusion-state.mjs autopilot <リポジトリ>`でラウンド実行と独立した委任レビューを自動進行できます。リードが承認した`acceptance_commands`が必要で、基準ツリーで失敗が確認された（red）コマンドでなければなりません（保存検証の作業は逆に、すでに通ることが確認されている必要があります）。classicのレビューでは`review.auto_apply:true`も必要です（`lead-gated-adaptive`はどのみちリードゲートで止まるため要求しません）。VERIFY・設計判断・BLOCKED・takeoverではリードに制御を返し、プロセス停止・スナップショット・予算・検証の確認に失敗した場合も停止します。リードが裁量権を与えた作業は、コントローラが承認したラウンドのverifyまで進みます（[運用説明（韓国語）](references/operations.md#오토파일럿)）。

受け入れテストでも子プロセスの停止を確認します。停止の証拠がなければRECOVERY_REQUIREDで止まり、リードの停止確認を待ちます。タスクの時間上限は受け入れテストと最終検証にも適用されます。

外部に送るbrief・diff・過去の結果には、メール・IP・キー・パスワードのパターンマスキングを標準適用します。認証に必要なベンダー環境変数は維持します。CLIが直接読み取って送るリポジトリの内容まで保護するDLPではないため、社内コードではファイルアクセスと外部送信の方針も別途管理してください（[送信範囲（韓国語）](references/operations.md#외부-전송-마스킹)）。

## ドキュメント

ドキュメントの本文は韓国語です。最初は[runtime](references/runtime.md)（コマンド）と[configuration](references/configuration.md)（設定）から読んでください。リード向けの英語の要約は[executor-quickstart](references/executor-quickstart.md)です。

| テーマ | ドキュメント |
|---|---|
| 状態とコマンド | [runtime](references/runtime.md) · [state-actions](references/state-actions.md)（自動生成） · [state-schema](references/state-schema.json) · [operations](references/operations.md)（運用・オートパイロット・フック・受け入れテスト） |
| 設定 | [configuration](references/configuration.md)（環境変数を含む） · [codex-runtime](references/codex-runtime.md) |
| ワーカー | [executor-runtime](references/executor-runtime.md)（Windows含む） · [routing](references/routing.md) · [herdr](references/herdr.md)（任意：Herdr観測pane） |
| 契約 | [delegation-protocol](references/delegation-protocol.md)（brief） · [result-protocol](references/result-protocol.md) |
| 検収 | [review-protocol](references/review-protocol.md) · [review-pairs](references/review-pairs.md) · [finding-ledger](references/finding-ledger.md) · [consult](references/consult.md) · [read-only-work](references/read-only-work.md) · [universal-supervisor](references/universal-supervisor.md)（v0.3・裁量権） |
| 失敗と復旧 | [failure-protocol](references/failure-protocol.md) · [recovery-protocol](references/recovery-protocol.md) · [reconciliation](references/reconciliation.md) |
| プロジェクト・記憶・指標 | [project](references/project.md) · [workflow-plan](references/workflow-plan.md) · [memory](references/memory.md) · [memory-recall](references/memory-recall.md) · [metrics-policy](references/metrics-policy.md) · [benchmark-pilot](references/benchmark-pilot.md) |
| 実験ツール | [evidence-retrieval-experiment](references/evidence-retrieval-experiment.md) · [controller-overhead](references/controller-overhead.md) |
| 設計メモと過去の記録 | [app-handoff-design](references/app-handoff-design.md)（後続設計） · [archive](references/archive/README.md)（時点ごとの検証・監査記録） |

## テストと制約

```sh
npm test
```

自動テストが、状態機械、ワーカーアダプタ、配置、レビュー委任、裁量権と自動復旧、記憶層、プロジェクトの流れ、セキュリティ、マスキングとオートパイロットを確認します。実際のCLIを使うスモーク1件は`HF_LIVE=1`の時だけ実行します。GitHub ActionsはUbuntu・Windows × Node 24で実行する構成です。Windowsではテストファイルを順次実行し（他のOSは並列度2）、実際に孤児プロセスを作る回帰テストは並列テストの後に別途実行します。`npm run spawns`がテスト（または指定したコマンド）の作る子プロセスをコマンド別・呼び出し箇所別に数えます。

**テストの`grok`/`agy`/`claude`/`codex`は代役のCLIです。** 実際のモデル呼び出し、認証、画像生成は、このリポジトリのテストでは検証されていません。インストール済みCLIに必要なフラグがない場合は、実行前に`ADAPTER_UNAVAILABLE`で拒否します。CLIフラグは[Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)、[Antigravity CLI](https://antigravity.google/docs/cli/headless)、[Claude Code](https://code.claude.com/docs/en/headless)のドキュメントを基準にしています。裁量権の自動復旧が「やり直しても同じ失敗」を見分ける文言判定も代役CLIが基準なので、実際のCLIでは最初の数回、`recovery-*.json`の`reason`を確認することをおすすめします。実モデルの費用・時間削減は未測定です。

ライセンスは[MIT](LICENSE)。

## 参考にしたもの

- [Orca](https://github.com/stablyai/orca)、[Paseo](https://github.com/getpaseo/paseo)：advisor/committee、行単位のフィードバック、通知。worktree競争は単一作業ツリーの原則と合わないため取り入れていません。
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp)：記憶層の設計（重複統合、矛盾レビュー、減衰、出典表示）。接続はせず、設計だけを取り入れて自前で実装しました。
- [cli-dispatch](https://github.com/rbinar/cli-dispatch)：他社のCLIに仕事を任せる似たプラグイン。agyのモデル名検証、コンパクション後の状態注入、Codex残量の読み取りを参考にしました。worktreeのパッチ方式は単一writerの原則と合わないため取り入れていません。
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)：doubt-driven developmentから「レビュアーに主張を渡さない」と指摘の分類（契約の誤読・対応・トレードオフ・ノイズ）を取り入れました。
- [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack)：interrogateのリード判断（Act on / Consider / Noted / Dismissed、却下理由の公開）を指摘ごとの処分に反映しました。
- [mattpocock/skills](https://github.com/mattpocock/skills)：規約軸と仕様軸を分けたレビュー、依存グラフによる作業分解を検討しました。並列実装は単一writerの原則と合わないため取り入れていません。
