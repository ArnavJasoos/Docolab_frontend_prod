import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.security import get_password_hash, verify_password, create_access_token
from app.models.database_models import User
from app.schemas.auth import UserCreate, Token, LoginRequest, UserResponse

router = APIRouter()

@router.post("/signup", response_model=Token, status_code=status.HTTP_201_CREATED)
def signup(data: UserCreate, db: Session = Depends(get_db)):
    existing_user = db.query(User).filter(User.email == data.email).first()
    if existing_user:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    
    org_id = str(uuid.uuid4())
    hashed_password = get_password_hash(data.password)
    
    user = User(
        org_id=org_id,
        email=data.email,
        password_hash=hashed_password,
        display_name=data.display_name,
        avatar_color="#7aa2f7",
        status="active"
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    
    token = create_access_token(subject=user.id)
    return {"user": user, "token": token}

@router.post("/login", response_model=Token)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    
    if user.status == "disabled":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account")
        
    token = create_access_token(subject=user.id)
    return {"user": user, "token": token}

@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user