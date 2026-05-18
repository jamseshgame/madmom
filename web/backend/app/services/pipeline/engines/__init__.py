"""Engine modules. Importing this package registers every engine into
the global registry via side effect."""
from __future__ import annotations

from . import grid_librosa, grid_manual, onsets_librosa  # noqa: F401

try:
    from . import grid_allinone  # noqa: F401
except ImportError:
    # all-in-one is an extras dep — skip when not installed
    pass

try:
    from . import onsets_basic_pitch, pitches_basic_pitch  # noqa: F401
except ImportError:
    # basic-pitch is an extras dep — skip when not installed
    pass

try:
    from . import onsets_aubio  # noqa: F401
except ImportError:
    # aubio is an extras dep — skip when not installed
    pass

from . import pitches_passthrough  # noqa: F401

from . import pitches_yin  # noqa: F401

try:
    from . import pitches_crepe  # noqa: F401
except ImportError:
    # torchcrepe is an extras dep — skip when not installed
    pass

from . import quantized_engines  # noqa: F401

from . import lanes_engines  # noqa: F401

from . import playability_engines  # noqa: F401

from . import difficulty_engines  # noqa: F401
