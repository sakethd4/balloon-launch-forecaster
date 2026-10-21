from src.ingest import gefs

IDX = """1:0:d=2024050112:HGT:10 mb:24 hour fcst:ens std dev
2:100:d=2024050112:UGRD:300 mb:24 hour fcst:ens std dev
3:200:d=2024050112:VGRD:300 mb:24 hour fcst:ens std dev
4:300:d=2024050112:TMP:300 mb:24 hour fcst:ens std dev
5:400:d=2024050112:UGRD:200 mb:24 hour fcst:ens std dev
6:500:d=2024050112:UGRD:250 mb:24 hour fcst:ens std dev
7:600:d=2024050112:VGRD:500 mb:24 hour fcst:ens std dev"""


def test_select_ranges_takes_only_wanted_winds_and_merges_neighbours():
    # u300+v300 are adjacent (merged); u200 is separate; 250 mb and temperature are not wanted;
    # v500 is the last message, so it runs to the end of the file
    assert gefs.select_ranges(IDX) == [(100, 300), (400, 500), (600, None)]
