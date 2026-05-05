import { VersionsTable } from '../components/VersionStatus.tsx'

export default function DependenciesPage() {
  // VersionsTable already renders its own header + description, so this
  // page is just a thin route wrapper.
  return <VersionsTable />
}
