export default function RemixPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Remix Beatmap</h1>
        <p className="text-gray-500 mt-1">Adjust parameters and regenerate difficulty levels.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-gray-400 text-lg">Coming soon</p>
        <p className="text-gray-600 mt-2 text-sm max-w-md mx-auto">
          This will let you load an existing .chart, adjust onset threshold, chord density, quantization,
          and slide sensitivity per difficulty, then regenerate.
        </p>
        <div className="mt-6 space-y-4 max-w-sm mx-auto opacity-40 pointer-events-none">
          {[
            { label: 'Onset Threshold', value: 35 },
            { label: 'Chord Density', value: 60 },
            { label: 'Quantize (1/N)', value: 16 },
            { label: 'Slide Sensitivity', value: 50 },
          ].map(({ label, value }) => (
            <label key={label} className="block text-left">
              <span className="text-xs text-gray-500">{label}</span>
              <input
                type="range"
                min="0"
                max="100"
                defaultValue={value}
                className="mt-1 block w-full"
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
