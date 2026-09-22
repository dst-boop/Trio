import Workspace from '@/components/workspace';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
export const dynamic = 'force-dynamic';
export default async function WorkspacePage() {
  const user = await requireChatGPTUser('/workspace');
  return <Workspace account={{ userId: user.userId, displayName: user.displayName, email: user.email }} />;
}
