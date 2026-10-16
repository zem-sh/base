import { Skeleton } from './skeleton'

export function StatsCardSkeleton() {
  return (
    <div className="flex flex-col rounded-md overflow-hidden p-1.5 sm:p-2 bg-card" style={{ minHeight: 200 }}>
      <div className="flex px-2 sm:px-3 items-center justify-between">
        <Skeleton className="w-16 h-3 sm:w-20 sm:h-3" />
        <Skeleton className="w-8 h-2 sm:w-10 sm:h-2" />
      </div>
      <div className="flex px-2 sm:px-4 py-2 sm:py-4 items-end gap-1">
        <Skeleton className="w-16 h-8 sm:w-20 sm:h-12" />
        <Skeleton className="w-4 h-4 sm:w-5 sm:h-5" />
      </div>
      <Skeleton className="w-full flex-1 mx-1 my-1" />
      <div className="flex items-center px-2 sm:px-3 gap-2">
        <Skeleton className="w-16 h-3 sm:w-20 sm:h-3" />
      </div>
    </div>
  )
}

export function ProcessTableSkeleton() {
  return (
    <div className="rounded-md bg-card flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center h-8 sm:h-10 px-2 sm:px-4 bg-muted rounded-t-md">
        <Skeleton className="w-10 h-3 sm:w-12 sm:h-4" />
        <Skeleton className="w-16 sm:w-24 h-3 sm:h-4 ml-4" />
        <Skeleton className="w-10 sm:w-14 h-3 sm:h-4 ml-auto" />
        <Skeleton className="w-10 sm:w-14 h-3 sm:h-4 ml-4" />
        <Skeleton className="w-6 h-3 sm:w-8 sm:h-4 ml-4" />
      </div>
      <div className="space-y-0">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center h-10 sm:h-12 px-2 sm:px-4 border-none">
            <Skeleton className="w-10 h-3 sm:w-12 sm:h-4" />
            <Skeleton className="w-20 sm:w-32 h-3 sm:h-4 ml-4" />
            <Skeleton className="w-10 sm:w-14 h-3 sm:h-4 ml-auto" />
            <Skeleton className="w-10 sm:w-14 h-3 sm:h-4 ml-4" />
            <Skeleton className="w-6 h-3 sm:w-8 sm:h-4 ml-4" />
          </div>
        ))}
      </div>
    </div>
  )
}
