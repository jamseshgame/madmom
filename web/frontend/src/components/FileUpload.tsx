import { useCallback, useRef, useState } from 'react'

interface FileUploadProps {
  accept: string
  label: string
  onFile: (file: File) => void
  maxMb?: number
}

export default function FileUpload({ accept, label, onFile, maxMb = 200 }: FileUploadProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      if (maxMb && file.size > maxMb * 1024 * 1024) {
        alert(`File too large. Max ${maxMb} MB.`)
        return
      }
      onFile(file)
    },
    [onFile, maxMb],
  )

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleFile(e.dataTransfer.files[0])
      }}
      className={`cursor-pointer border-2 border-dashed rounded-xl p-10 text-center transition-colors ${
        dragOver ? 'border-jam-400 bg-jam-600/10' : 'border-gray-700 hover:border-gray-500'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <p className="text-gray-400 text-lg">{label}</p>
      <p className="text-gray-600 text-sm mt-2">Click or drag & drop</p>
    </div>
  )
}
