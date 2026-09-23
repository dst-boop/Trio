import type { ProviderId } from '../lib/trio.ts';
import type { Verdict } from './cases.ts';

type Row = { category: string; baseline: Partial<Record<ProviderId, Verdict>>; team: Verdict; baselineRun: { degraded: boolean }; teamRun: { degraded: boolean } };
const scored = (v?: Verdict) => v?.status === 'pass' || v?.status === 'incorrect';
const empty = () => ({ eligible: 0, introducedErrors: 0, correctedErrors: 0, unchangedCorrect: 0, unchangedIncorrect: 0, excluded: 0 });

/** Paired outcomes of separate samples, not causal evidence of review quality. */
export function compareOutcomes(rows: Row[], baselineProvider: ProviderId, selected: ProviderId[]) {
 const overall=empty(), byCategory:Record<string,ReturnType<typeof empty>>={};
 const majority={eligible:0,introducedErrors:0,excluded:0};
 for(const row of rows) {
  const category=byCategory[row.category]??=empty();
  const baseline=row.baseline[baselineProvider];
  const comparable=!row.baselineRun.degraded&&!row.teamRun.degraded&&scored(baseline)&&scored(row.team);
  for(const totals of [overall,category]) {
   if(!comparable){totals.excluded++;continue;}
   totals.eligible++;
   if(baseline!.status==='pass'&&row.team.status==='incorrect')totals.introducedErrors++;
   else if(baseline!.status==='incorrect'&&row.team.status==='pass')totals.correctedErrors++;
   else if(row.team.status==='pass')totals.unchangedCorrect++;
   else totals.unchangedIncorrect++;
  }
  if(selected.length<2||row.baselineRun.degraded||row.teamRun.degraded||!scored(row.team)||selected.some(p=>!scored(row.baseline[p]))) {majority.excluded++;continue;}
  majority.eligible++;
  if(row.team.status==='incorrect'&&selected.filter(p=>row.baseline[p]?.status==='pass').length>selected.length/2)majority.introducedErrors++;
 }
 return {baselineProvider,overall,byCategory,majority};
}
