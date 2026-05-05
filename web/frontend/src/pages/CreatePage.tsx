import CreateSection from '../components/CreateSection.tsx'

export default function CreatePage() {
  // The post-separation stem editor lives inside CreateSection itself, so the
  // user keeps working on the freshly-created track right here. Studio Library
  // refetches on mount, so no explicit refresh callback is needed.
  return <CreateSection />
}
