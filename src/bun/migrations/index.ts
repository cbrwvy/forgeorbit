import { companyActivityJournalMigration } from "./092_company_activity_journal.ts";
import { taskDependencyTombstonesMigration } from "./093_task_dependency_tombstones.ts";
import m094 from "./094_task_plan_queues.sql" with { type: "text" };
import m095 from "./095_task_queue_progression.sql" with { type: "text" };
import m096 from "./096_pm_intake_grants.sql" with { type: "text" };
import m097 from "./097_project_rules.sql" with { type: "text" };
import m098 from "./098_task_quality_reviews.sql" with { type: "text" };
import m099 from "./099_pm_orchestrated_workflows.sql" with { type: "text" };
import m100 from "./100_knowledge_inheritance.sql" with { type: "text" };
import m101 from "./101_deployment_requests.sql" with { type: "text" };
import m102 from "./102_deployment_staging_adapter.sql" with { type: "text" };
import m103 from "./103_deployment_image_catalog.sql" with { type: "text" };
import m104 from "./104_pm_orchestrated_batches.sql" with { type: "text" };
import m105 from "./105_head_pm_initiatives.sql" with { type: "text" };
import m107 from "./107_head_pm_auto.sql" with { type: "text" };
import m108 from "./108_allocation_plans.sql" with { type: "text" };
import m109 from "./109_qc_recovery_grants.sql" with { type: "text" };
import m110 from "./110_run_source_evidence.sql" with { type: "text" };
import m111 from "./111_review_test_authorizations.sql" with { type: "text" };
import m112 from "./112_task_workspaces.sql" with { type: "text" };
import m113 from "./113_pm_provider_recovery.sql" with { type: "text" };
import m114 from "./114_project_lifecycle.sql" with { type: "text" };
import m115 from "./115_brain_context.sql" with { type: "text" };
import m116 from "./116_brain_memory_proposals.sql" with { type: "text" };
import m117 from "./117_browser_agent_grants.sql" with { type: "text" };
import { nativeComputerJournalMigration } from "./118_native_computer_journal.ts";
import m120 from "./120_head_board_proposals.sql" with { type: "text" };
import m121 from "./121_brain_2_0.sql" with { type: "text" };
import m122 from "./122_ai_router_2.sql" with { type: "text" };
import m123 from "./123_multi_project_orchestration.sql" with { type: "text" };
import m124 from "./124_autonomy_policies.sql" with { type: "text" };
import m125 from "./125_self_improvement.sql" with { type: "text" };
import m126 from "./126_execution_profiles.sql" with { type: "text" };
import m127 from "./127_infra_auto.sql" with { type: "text" };
import m128 from "./128_practical_cycle.sql" with { type: "text" };
import m129 from "./129_usage_analytics.sql" with { type: "text" };
import m131 from "./131_forecast_revision.sql" with { type: "text" };
import m132 from "./132_mission_replanning.sql" with { type: "text" };
import m133 from "./133_mission_preparation.sql" with { type: "text" };
import m134 from "./134_usage_adjustments.sql" with { type: "text" };
import m135 from "./135_router_decision_authority.sql" with { type: "text" };
import m136 from "./136_owner_trust.sql" with { type: "text" };
import m137 from "./137_owner_trust_signing_cert.sql" with { type: "text" };
import m138 from "./138_project_permissions.sql" with { type: "text" };
import m139 from "./139_project_permission_origin.sql" with { type: "text" };
import m140 from "./140_provider_refusals.sql" with { type: "text" };
import m141 from "./141_provider_answers.sql" with { type: "text" };
import m142 from "./142_run_terminations.sql" with { type: "text" };
import m143 from "./143_router_issued_plans.sql" with { type: "text" };
import m144 from "./144_improvement_evaluation_traceability.sql" with { type: "text" };
import m145 from "./145_task_access_mode.sql" with { type: "text" };
import m146 from "./146_qc_review_evidence_state.sql" with { type: "text" };
import m147 from "./147_project_workspace_development.sql" with { type: "text" };
import m148 from "./148_objective_mission_tasks.sql" with { type: "text" };
import m149 from "./149_task_computer_workflows.sql" with { type: "text" };
import m150 from "./150_project_handsoff.sql" with { type: "text" };
import m151 from "./151_handsoff_authorization.sql" with { type: "text" };
import m152 from "./152_task_urgency_order.sql" with { type: "text" };
import m153 from "./153_task_available_from.sql" with { type: "text" };
import m154 from "./154_recurring_tasks.sql" with { type: "text" };
import m119 from "./119_native_computer_agent_grants.sql" with { type: "text" };
import m106 from "./106_head_pm_initiative_proposals.sql" with { type: "text" };
import { professionalTurnsMigration } from "./091_professional_execution_turns.ts";
import { legacyHiringCompatibility } from './088a_legacy_hiring_compatibility.ts';
// Each new migration: create NNN_name.sql, then add a line below.
// The file order here is the apply order — never reorder, never edit applied migrations.
import m001 from "./001_init.sql" with { type: "text" };
import m002 from "./002_worktree.sql" with { type: "text" };
import m003 from "./003_base_ref.sql" with { type: "text" };
import m004 from "./004_mode_model.sql" with { type: "text" };
import m005 from "./005_projects.sql" with { type: "text" };
import m006 from "./006_attachments.sql" with { type: "text" };
import m007 from "./007_effort.sql" with { type: "text" };
import m008 from "./008_tmux_session.sql" with { type: "text" };
import m009 from "./009_claude_session_id.sql" with { type: "text" };
import m010 from "./010_approval_rules.sql" with { type: "text" };
import m011 from "./011_preferences.sql" with { type: "text" };
import m012 from "./012_task_references.sql" with { type: "text" };
import m013 from "./013_harnesses.sql" with { type: "text" };
import m014 from "./014_harness_enabled.sql" with { type: "text" };
import m015 from "./015_default_model_effort.sql" with { type: "text" };
import m016 from "./016_disable_codex.sql" with { type: "text" };
import m017 from "./017_drop_approval_rules.sql" with { type: "text" };
import m018 from "./018_run_events_dedup.sql" with { type: "text" };
import m019 from "./019_archived_at.sql" with { type: "text" };
import m020 from "./020_task_type.sql" with { type: "text" };
import m021 from "./021_codex_session_id.sql" with { type: "text" };
import m022 from "./022_subagents.sql" with { type: "text" };
import m023 from "./023_run_origin.sql" with { type: "text" };
import m024 from "./024_reseed_harness_builtins.sql" with { type: "text" };
import m025 from "./025_task_backlog.sql" with { type: "text" };
// Appends after main's 022–025 (this branch originally used 024, renumbered on
// merge to avoid the clash with 024_reseed_harness_builtins).
import m026 from "./026_project_branch_config.sql" with { type: "text" };
import m027 from "./027_subagent_tool_use_id.sql" with { type: "text" };
import m028 from "./028_branch_source.sql" with { type: "text" };
// This branch originally used 028 for task_draft; renumbered to 029 on merge
// to avoid the clash with main's 028_branch_source (same as 026 above).
import m029 from "./029_task_draft.sql" with { type: "text" };
import m030 from "./030_runs_task_id_index.sql" with { type: "text" };
// This branch originally used 030 for task_pr_url; renumbered to 031 on merge
// to avoid the clash with main's 030_runs_task_id_index (same as 026/029 above).
import m031 from "./031_task_pr_url.sql" with { type: "text" };
// The cursor branch originally used 024/025; renumbered to 032/033 on merge to
// avoid the clash with 024_reseed_harness_builtins/025_task_backlog (same as
// 026/029/031 above).
import m032 from "./032_cursor_harness.sql" with { type: "text" };
import m033 from "./033_cursor_session_id.sql" with { type: "text" };
import m034 from "./034_task_fast.sql" with { type: "text" };
import m035 from "./035_task_max_mode.sql" with { type: "text" };
// The gemini branch originally used 032/033/034; renumbered to 036/037/038 on
// merge to avoid the clash with the cursor branch's 032-035 above (same
// renumber-with-alias pattern).
import m036 from "./036_gemini_session_id.sql" with { type: "text" };
import m037 from "./037_harness_kind_gemini.sql" with { type: "text" };
import m038 from "./038_reseed_harness_builtins_2.sql" with { type: "text" };
// This branch used 035 then 036 for run_events_user_history across two
// main-merges (max-mode took 035, gemini took 036); renumbered to 039 with
// both prior ids as aliases (same renumber-with-alias pattern).
import m039 from "./039_run_events_user_history.sql" with { type: "text" };
import m040 from "./040_saved_prompts.sql" with { type: "text" };
import m041 from "./041_task_plans.sql" with { type: "text" };
import m042 from "./042_subagents_running_idx.sql" with { type: "text" };
import m043 from "./043_harness_usage.sql" with { type: "text" };
import m044 from "./044_todo_progress.sql" with { type: "text" };
import m045 from "./045_unread_watermarks.sql" with { type: "text" };
import m046 from "./046_fx_harness.sql" with { type: "text" };
import m047 from "./047_fx_session_id.sql" with { type: "text" };
import m048 from "./048_issue_url.sql" with { type: "text" };
import m049 from "./049_retire_gemini_3_pro_preview.sql" with { type: "text" };
import m050 from "./050_sent_files.sql" with { type: "text" };
import m051 from "./051_fx_recovery.sql" with { type: "text" };
import m052 from "./052_agent_profiles.sql" with { type: "text" };
import m053 from "./053_task_agent_profile.sql" with { type: "text" };
// Authored as 040_account_usage on the multi-account-discovery branch
// (pre-upstream-sync numbering); renumbered to 054 on port, original id kept
// as an alias (same renumber-with-alias pattern used throughout this file).
import m054 from "./054_account_usage.sql" with { type: "text" };
import m055 from "./055_normalize_cursor_grok_4_7.sql" with { type: "text" };
import m056 from "./056_normalize_cursor_opus_5_5.sql" with { type: "text" };
// Pipelines landed on a branch as 056/057 while `main` took 056 for the
// cursor Opus 5.5 normalization — renumbered to 057/058 on merge, original
// ids kept as aliases (same renumber-with-alias pattern as 054 above).
import m057 from "./057_pipelines.sql" with { type: "text" };
import m058 from "./058_task_pipeline.sql" with { type: "text" };
import m059 from "./059_task_pipeline_id_index.sql" with { type: "text" };
// Cursor Sonnet 5.5 normalization was written on its branch as 057 while
// `main` took 057–059 for pipelines — renumbered to 060 on rebase, original
// id kept as an alias (same renumber-with-alias pattern as 054/057/058).
import m060 from "./060_normalize_cursor_sonnet_5_5.sql" with { type: "text" };
import m061 from "./061_antigravity_harness.sql" with { type: "text" };
import m062 from "./062_normalize_cursor_haiku_5_5.sql" with { type: "text" };
import m063 from "./063_task_checkout_branch.sql" with { type: "text" };
// The Gemini 4 Argon migrations were written on their branch as 063–065 while
// `main` took 063 for the task checkout branch — renumbered to 064–066 on
// merge, original ids kept as aliases (same renumber-with-alias pattern as
// 054/057/058/060).
import m064 from "./064_normalize_cursor_gemini_4_argon.sql" with { type: "text" };
import m065 from "./065_antigravity_effort_in_model_id.sql" with { type: "text" };
import m066 from "./066_retire_gemini_3_7_and_3_5_flash.sql" with { type: "text" };
import m067 from "./067_retention_swept_tasks.sql" with { type: "text" };
import m068 from "./068_project_interviews.sql" with { type: "text" };
import m069 from "./069_environment_profiles.sql" with { type: "text" };
import m070 from "./070_project_managers.sql" with { type: "text" };
import m071 from "./071_project_manager_executions.sql" with { type: "text" };
import m072 from "./072_task_scheduling.sql" with { type: "text" };
import m073 from "./073_execution_batches.sql" with { type: "text" };
// Authored as 071_project_estimation. Main already registers
// 071_project_manager_executions, and FO-005C.1 registers
// 072_task_scheduling plus 073_execution_batches, so this migration is 074.
// The alias is only this migration's own previous id. migrate() matches
// ids, not numeric ranges: a database that already has 074 still applies
// 072 and 073 when those entries are inserted earlier in this list.
import m074 from "./074_project_estimation.sql" with { type: "text" };
import m076 from "./076_account_quota_core.sql" with { type: "text" };
import m075 from "./075_portfolio_manager.sql" with { type: "text" };
// FO-011A. Next free id after 076 on e923fd1. If FO-009B also takes 077,
// renumber this migration on integration; do not edit the other branch's file.
import m077 from "./077_cluster_registry.sql" with { type: "text" };
// FO-011C. Reserved after 077. Do not reuse this id for another feature.
import m078 from "./078_knowledge_documents.sql" with { type: "text" };
import m079 from "./079_ai_employees.sql" with { type: "text" };
import m080 from "./080_infrastructure_inventory.sql" with { type: "text" };
import m081 from "./081_employee_task_assignments.sql" with { type: "text" };
import m082 from "./082_knowledge_context.sql" with { type: "text" };
import m084 from "./084_organization_assignment_proposals.sql" with { type: "text" };
import m085 from "./085_employee_execution_attribution.sql" with { type: "text" };
import m086 from "./086_head_portfolio_binding.sql" with { type: "text" };
import m087 from "./087_employee_professional_profiles.sql" with { type: "text" };
import m088 from "./088_employee_hiring_proposals.sql" with { type: "text" };
import { professionalRuntimeMigration } from "./090_professional_runtime.ts";
import m089 from "./089_hiring_proposal_dedup.sql" with { type: "text" };
import m155 from "./155_custom_cli_harnesses.sql" with { type: "text" };


import type { Migration } from "../migrate.ts";

export const migrations: Migration[] = [
  { id: "001_init", sql: m001 },
  { id: "002_worktree", sql: m002 },
  { id: "003_base_ref", sql: m003 },
  { id: "004_mode_model", sql: m004 },
  { id: "005_projects", sql: m005 },
  { id: "006_attachments", sql: m006 },
  { id: "007_effort", sql: m007 },
  { id: "008_tmux_session", sql: m008 },
  { id: "009_claude_session_id", sql: m009 },
  { id: "010_approval_rules", sql: m010 },
  { id: "011_preferences", sql: m011 },
  { id: "012_task_references", sql: m012 },
  { id: "013_harnesses", sql: m013 },
  { id: "014_harness_enabled", sql: m014 },
  { id: "015_default_model_effort", sql: m015 },
  { id: "016_disable_codex", sql: m016 },
  { id: "017_drop_approval_rules", sql: m017 },
  { id: "018_run_events_dedup", sql: m018 },
  { id: "019_archived_at", sql: m019 },
  { id: "020_task_type", sql: m020 },
  { id: "021_codex_session_id", sql: m021 },
  { id: "022_subagents", sql: m022 },
  { id: "023_run_origin", sql: m023 },
  { id: "024_reseed_harness_builtins", sql: m024 },
  { id: "025_task_backlog", sql: m025 },
  { id: "026_project_branch_config", sql: m026, aliases: ["024_project_branch_config"] },
  { id: "027_subagent_tool_use_id", sql: m027 },
  { id: "028_branch_source", sql: m028 },
  { id: "029_task_draft", sql: m029, aliases: ["028_task_draft"] },
  { id: "030_runs_task_id_index", sql: m030 },
  { id: "031_task_pr_url", sql: m031, aliases: ["030_task_pr_url"] },
  { id: "032_cursor_harness", sql: m032, aliases: ["024_cursor_harness"] },
  { id: "033_cursor_session_id", sql: m033, aliases: ["025_cursor_session_id"] },
  { id: "034_task_fast", sql: m034 },
  { id: "035_task_max_mode", sql: m035 },
  { id: "036_gemini_session_id", sql: m036, aliases: ["032_gemini_session_id"] },
  { id: "037_harness_kind_gemini", sql: m037, aliases: ["033_harness_kind_gemini"] },
  { id: "038_reseed_harness_builtins_2", sql: m038, aliases: ["034_reseed_harness_builtins_2"] },
  { id: "039_run_events_user_history", sql: m039, aliases: ["035_run_events_user_history", "036_run_events_user_history"] },
  { id: "040_saved_prompts", sql: m040 },
  { id: "041_task_plans", sql: m041 },
  { id: "042_subagents_running_idx", sql: m042 },
  { id: "043_harness_usage", sql: m043, aliases: ["042_harness_usage"] },
  { id: "044_todo_progress", sql: m044 },
  { id: "045_unread_watermarks", sql: m045 },
  // fx's two migrations were authored as 045/046 on their branch while main
  // claimed 045 for the unread watermarks; renumbered on merge (house rule:
  // whoever merges second renumbers) with the original ids kept as aliases
  // so a dev DB that already applied them is not re-migrated.
  { id: "046_fx_harness", sql: m046, aliases: ["045_fx_harness"] },
  { id: "047_fx_session_id", sql: m047, aliases: ["046_fx_session_id"] },
  { id: "048_issue_url", sql: m048 },
  { id: "049_retire_gemini_3_pro_preview", sql: m049 },
  { id: "050_sent_files", sql: m050 },
  { id: "051_fx_recovery", sql: m051 },
  { id: "052_agent_profiles", sql: m052 },
  { id: "053_task_agent_profile", sql: m053 },
  { id: "054_account_usage", sql: m054, aliases: ["040_account_usage"] },
  { id: "055_normalize_cursor_grok_4_7", sql: m055 },
  { id: "056_normalize_cursor_opus_5_5", sql: m056 },
  { id: "057_pipelines", sql: m057, aliases: ["056_pipelines"] },
  { id: "058_task_pipeline", sql: m058, aliases: ["057_task_pipeline"] },
  { id: "059_task_pipeline_id_index", sql: m059 },
  { id: "060_normalize_cursor_sonnet_5_5", sql: m060, aliases: ["057_normalize_cursor_sonnet_5_5"] },
  { id: "061_antigravity_harness", sql: m061 },
  { id: "062_normalize_cursor_haiku_5_5", sql: m062 },
  { id: "063_task_checkout_branch", sql: m063 },
  { id: "064_normalize_cursor_gemini_4_argon", sql: m064, aliases: ["063_normalize_cursor_gemini_4_argon"] },
  { id: "065_antigravity_effort_in_model_id", sql: m065, aliases: ["064_antigravity_effort_in_model_id"] },
  { id: "066_retire_gemini_3_7_and_3_5_flash", sql: m066, aliases: ["065_retire_gemini_3_7_and_3_5_flash"] },
  { id: "067_retention_swept_tasks", sql: m067 },
  { id: "068_project_interviews", sql: m068 },
  { id: "069_environment_profiles", sql: m069 },
  { id: "070_project_managers", sql: m070 },
  { id: "071_project_manager_executions", sql: m071 },
  { id: "072_task_scheduling", sql: m072 },
  { id: "073_execution_batches", sql: m073 },
  { id: "074_project_estimation", sql: m074, aliases: ["071_project_estimation"] },
  { id: "075_portfolio_manager", sql: m075 },
  { id: "076_account_quota_core", sql: m076 },
  { id: "077_cluster_registry", sql: m077 },
  { id: "078_knowledge_documents", sql: m078 },
  { id: "079_ai_employees", sql: m079 },
  { id: "080_infrastructure_inventory", sql: m080 },
  { id: "081_employee_task_assignments", sql: m081 },
  { id: "082_knowledge_context", sql: m082 },
  { id: "084_organization_assignment_proposals", sql: m084 },
  { id: "085_employee_execution_attribution", sql: m085 },
  { id: "086_head_portfolio_binding", sql: m086 },
  { id: "087_employee_professional_profiles", sql: m087 },
  { id: "088_employee_hiring_proposals", sql: m088 },
  legacyHiringCompatibility,
  { id: "089_hiring_proposal_dedup", sql: m089 },
  professionalRuntimeMigration,
  professionalTurnsMigration,
  companyActivityJournalMigration,
  taskDependencyTombstonesMigration,
  { id: "094_task_plan_queues", sql: m094 },
  { id: "095_task_queue_progression", sql: m095 },
  { id: "096_pm_intake_grants", sql: m096 },
  { id: "097_project_rules", sql: m097 },
  { id: "098_task_quality_reviews", sql: m098 },
  { id: "099_pm_orchestrated_workflows", sql: m099 },
  { id: "100_knowledge_inheritance", sql: m100 },
  { id: "101_deployment_requests", sql: m101 },
  { id: "102_deployment_staging_adapter", sql: m102 },
  { id: "103_deployment_image_catalog", sql: m103 },
  { id: "104_pm_orchestrated_batches", sql: m104 },
  { id: "105_head_pm_initiatives", sql: m105 },
  { id: "106_head_pm_initiative_proposals", sql: m106 },
  { id: "107_head_pm_auto", sql: m107 },
  { id: "108_allocation_plans", sql: m108 },
  { id: "109_qc_recovery_grants", sql: m109 },
  { id: "110_run_source_evidence", sql: m110 },
  { id: "111_review_test_authorizations", sql: m111 },
  { id: "112_task_workspaces", sql: m112 },
  { id: "113_pm_provider_recovery", sql: m113 },
  { id: "114_project_lifecycle", sql: m114 },
  { id: "115_brain_context", sql: m115 },
  { id: "116_brain_memory_proposals", sql: m116 },
  { id: "117_browser_agent_grants", sql: m117 },
  nativeComputerJournalMigration,
  { id: "119_native_computer_agent_grants", sql: m119 },
  { id: "120_head_board_proposals", sql: m120 },
  { id: "121_brain_2_0", sql: m121 },
  { id: "122_ai_router_2", sql: m122 },
  { id: "123_multi_project_orchestration", sql: m123 },
  { id: "124_autonomy_policies", sql: m124 },
  { id: "125_self_improvement", sql: m125 },
  { id: "126_execution_profiles", sql: m126 },
  { id: "127_infra_auto", sql: m127 },
  { id: "128_practical_cycle", sql: m128 },
  { id: "129_usage_analytics", sql: "", apply: db => { db.exec(m129); } },
  { id: "130_owner_quota_revisions", sql: `CREATE UNIQUE INDEX quota_observation_revision
    ON quota_observations(quota_id, json_extract(data, '$.revises'))
    WHERE json_extract(data, '$.revises') IS NOT NULL;` },
  { id: "131_forecast_revision", sql: "", apply: db => { db.exec(m131); } },
  { id: "132_mission_replanning", sql: m132 },
  { id: "133_mission_preparation", sql: m133 },
  { id: "134_usage_adjustments", sql: m134 },
  { id: "135_router_decision_authority", sql: m135 },
  { id: "136_owner_trust", sql: m136 },
  { id: "137_owner_trust_signing_cert", sql: m137 },
  { id: "138_project_permissions", sql: m138 },
  { id: "139_project_permission_origin", sql: m139 },
  { id: "140_provider_refusals", sql: m140 },
  { id: "141_provider_answers", sql: m141 },
  { id: "142_run_terminations", sql: m142 },
  { id: "143_router_issued_plans", sql: m143 },
  { id: "144_improvement_evaluation_traceability", sql: m144 },
  { id: "145_task_access_mode", sql: m145 },
  { id: "146_qc_review_evidence_state", sql: m146 },
  { id: "147_project_workspace_development", sql: m147 },
  { id: "148_objective_mission_tasks", sql: m148 },
  { id: "149_task_computer_workflows", sql: m149 },
  { id: "150_project_handsoff", sql: m150 },
  { id: "151_handsoff_authorization", sql: m151 },
  { id: "152_task_urgency_order", sql: m152 },
  { id: "153_task_available_from", sql: m153 },
  { id: "154_recurring_tasks", sql: m154 },
  { id: "155_custom_cli_harnesses", sql: m155 },
];
