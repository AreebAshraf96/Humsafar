from datetime import date
import sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import document_checks as documents

@pytest.mark.parametrize("value,expected,ambiguous",[("31/12/2030","2030-12-31",False),("2030-12-31","2030-12-31",False),("31 DEC 2030","2030-12-31",False),("02/03/2030",None,True),("31/02/2030",None,False),("unknown",None,False)])
def test_dates(value,expected,ambiguous):
    parsed,uncertain=documents.parse_date(value)
    assert (parsed.isoformat() if parsed else None)==expected
    assert uncertain==ambiguous

def test_labelled_fields():
    result=documents.check_text(["Name: Alex Sample","Licence No: TEST12345","Expiry: 31/12/2030"],"Alex Sample",date(2026,11,17))
    assert result["expiryStatus"]=="valid"
    assert result["nameStatus"]=="consistent"
    assert result["licenceNumberPresent"]
    assert result["state"]=="review_required"
    assert "Alex" not in str(result) and "TEST12345" not in str(result)

def test_dob_is_not_expiry():
    result=documents.check_text(["Date of birth: 01/01/2000","Issue date: 31/12/2020"],"Alex",date(2026,11,17))
    assert result["expiryDate"] is None

def test_expired_and_name_difference():
    result=documents.check_text(["Name: Alex Sample","Expiry: 31/12/2020"],"Other Name",date(2026,11,17))
    assert result["expiryStatus"]=="expired"
    assert result["nameStatus"]=="different"
    assert result["state"]=="review_required"

def test_conflicting_expiries():
    result=documents.check_text(["Expiry: 31/12/2030","Valid until: 31/12/2031"],today=date(2026,11,17))
    assert result["expiryStatus"]=="ambiguous"
    assert result["expiryDate"] is None

def test_blank_quality():
    result=documents.image_quality(np.full((500,500,3),255,dtype=np.uint8))
    assert not result["sharpnessOk"] and not result["lightingOk"]

def test_ocr_unavailable(monkeypatch):
    monkeypatch.setattr(documents,"ocr_engine",None)
    result=documents.document_checks(np.ones((500,500,3),dtype=np.uint8),np.ones((500,500,3),dtype=np.uint8))
    assert result["state"]=="unavailable"
    assert "reasons" in result

def test_real_ocr_on_synthetic_document():
    documents.load_ocr()
    assert documents.ocr_engine is not None,"OCR must initialize for this integration test"
    card=Image.new("RGB",(1200,700),"white")
    font_path=next((str(p) for p in [Path("C:/Windows/Fonts/arial.ttf"),Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")] if p.exists()),None)
    font=ImageFont.truetype(font_path,32) if font_path else ImageFont.load_default(size=32)
    draw=ImageDraw.Draw(card)
    for y,text in [(70,"SYNTHETIC TEST - NOT A REAL LICENCE"),(180,"Name: Alex Sample"),(280,"Licence No: TEST12345"),(380,"Expiry: 31 DEC 2030")]:draw.text((70,y),text,font=font,fill="black")
    array=cv2.cvtColor(np.asarray(card),cv2.COLOR_RGB2BGR)
    result=documents.document_checks(array,array,"Alex Sample")
    assert result["expiryDate"]=="2030-12-31",result
    assert result["nameStatus"]=="consistent",result
    assert result["licenceNumberPresent"],result
