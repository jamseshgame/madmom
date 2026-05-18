"""Engine modules. Importing this package registers every engine into
the global registry via side effect."""
from __future__ import annotations

from . import grid_librosa, grid_manual  # noqa: F401

try:
    from . import grid_allinone  # noqa: F401
except ImportError:
    # all-in-one is an extras dep — skip when not installed
    pass
