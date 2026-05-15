import CreateSection from '../components/CreateSection.tsx'
import { BusyProvider } from '../components/useExclusiveTask'

export default function CreatePage() {
  // The post-separation stem editor lives inside CreateSection itself, so the
  // user keeps working on the freshly-created track right here. Studio Library
  // refetches on mount, so no explicit refresh callback is needed.
  //
  // BusyProvider scopes the one-task-at-a-time lock to this page so any
  // backend-job trigger inside CreateSection / StemResult mutex-locks the
  // others.
  return (
    <BusyProvider>
      <CreateSection />
    </BusyProvider>
  )
}
