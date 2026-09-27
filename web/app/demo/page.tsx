import Workspace from '@/components/workspace';
import { env } from 'cloudflare:workers';
import { enabledFeatures } from '@/lib/features';
// Rendered per request so the operator's TRIO_DISABLED_FEATURES applies here too.
export const dynamic = 'force-dynamic';
export default function DemoPage() { return <Workspace features={enabledFeatures(env)} />; }
