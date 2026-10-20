from src.ingest.gfs import select_ranges

# Miniature .idx: offset, date, variable, level, forecast. Last message has no successor.
IDX = """\
1:0:d=2026010112:PRMSL:mean sea level:24 hour fcst:
2:100:d=2026010112:CLMR:1 hybrid level:24 hour fcst:
3:200:d=2026010112:UGRD:500 mb:24 hour fcst:
4:300:d=2026010112:UGRD:450 mb:24 hour fcst:
5:400:d=2026010112:UGRD:50 mb:24 hour fcst:
6:500:d=2026010112:VGRD:500 mb:24 hour fcst:
7:600:d=2026010112:TMP:2 m above ground:24 hour fcst:
8:700:d=2026010112:APCP:surface:0-24 hour acc fcst:
"""


def test_picks_wanted_fields_and_merges_adjacent():
    # PRMSL (0-100) wanted; CLMR no; UGRD 500+450 merged (200-400); UGRD 50 mb excluded
    # (above 100 hPa); VGRD 500, TMP 2 m and APCP are adjacent, so they merge into one
    # open-ended range because APCP is the last message.
    assert select_ranges(IDX) == [(0, 100), (200, 400), (500, None)]


def test_excludes_stratosphere_and_unwanted_variables():
    ranges = select_ranges(IDX)
    covered = [(s, e) for s, e in ranges]
    # offset 100 (CLMR) and 400 (UGRD 50 mb) must not be inside any range
    for off in (100, 400):
        assert not any(s <= off and (e is None or off < e) for s, e in covered)
